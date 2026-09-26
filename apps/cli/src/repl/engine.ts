/**
 * The REPL engine: input, the streaming render loop, approvals, budget and interrupts,
 * with no terminal of its own. `index.ts` binds it to a real stdin/stdout; the tests
 * bind it to arrays, which is what makes the behaviour assertable.
 */

import { GLYPHS, terminalWidth, type Theme } from "../ui/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { BUSY_STATUS_LINE, STOP_COMMAND } from "@trent/core/gateway/index.js";
import { TranscriptRenderer, identityForRole } from "./render.js";
import { BudgetLedger } from "./budget.js";
import { Conversation, doubleTextPolicy, historyLimits, TurnOutcome, type HistoryMessage } from "./conversation.js";
import { ApprovalGate, renderApprovalCard, type GateAnswer } from "./approvals.js";
import { questionFromEvent, renderQuestion } from "@trent/core/tools/human/index.js";
import { runCommand, commandNames } from "./commands.js";
import { autocomplete, applyCompletion, renderDropdown } from "./autocomplete.js";
import { renderDegradedBanner } from "./degraded.js";
import { rememberRun } from "./memory.js";
import { KeyDecoder, NEWLINE_HINT, type KeyEvent } from "./keys.js";
import { ABORT_REASON, InterruptController } from "./interrupt.js";
import { ContextTracker } from "./context-report.js";
import { GateKeys } from "./gate-keys.js"; // [S2]
import { buildReplContext, unseenNotices, type ReplSessionPorts } from "./session-view.js";
import type { ContextInspector, ReplConfig, ReplContext, ReplEgressStatus, ReplSandbox, ReplStore, ReplToolListing, ReplTraceStore } from "./types.js";

/** The prompt prefix. The mark is a mint dot; read the product name as `trent·`. */
export const PROMPT = "● ";

export { BUSY_STATUS_LINE };

/** A turn submitted while another was running, held until that one settles. */
interface QueuedTurn {
  text: string;
  settle: () => void;
  fail: (error: unknown) => void;
}

export interface ReplRunnerInput {
  objective: string;
  signal: AbortSignal;
  /** The turns before this one, oldest first. The objective stays the raw new line. */
  history?: readonly HistoryMessage[];
}

/** Produces the event stream for one turn. Bound to `createOrchestrator()` in index.ts. */
export type ReplRunner = (input: ReplRunnerInput) => AsyncIterable<OrcEvent>;

export interface ReplEngineDeps {
  theme: Theme;
  config: ReplConfig;
  store: ReplStore;
  companyId: string;
  runner: ReplRunner;
  write(text: string): void;
  exit(code: number): void;
  degraded?: boolean;
  degradedNotice?: string;
  traces?: ReplTraceStore;
  width?: number;
  /** This session's transcript, seeded on resume and persisted per turn. Its own, when absent. */
  conversation?: Conversation;
  /** Cents a resumed session had already spent, so the ticker continues rather than restarts. */
  openingCents?: number;
  /** The registered toolset adapters, the sandbox they run in and the egress state, for `/tools` and `/status`. */
  tools?: readonly ReplToolListing[];
  sandbox?: ReplSandbox;
  egress?: ReplEgressStatus;
  /** A1.2: the wrapper's measurement of what it injected, for `/context`. */
  contextInspector?: ContextInspector;
  /** How many times this session's stored transcript has been compacted, asked after every turn. */
  compactions?: () => number;
  /**
   * Lines the session owes the user once: a hook that did not run, a session hook that failed
   * (A2.2). Asked after every turn — a tool hook is skipped during a call, not at start-up — and
   * each distinct line is printed the first time it appears and never again.
   */
  notices?: () => readonly string[];
  /** The live managers the commands merged out of the slash module read (`session-view.ts`). */
  ports?: ReplSessionPorts;
  /**
   * Told when the human answers, so the orchestrator can release the step. `runId` is the run the
   * gate belongs to — taken from the event itself, never from a side list (live proof, F5).
   */
  onApprovalAnswer?(runId: string, stepId: string | undefined, answer: GateAnswer): Promise<void> | void;
  resume?: () => ReplRunner | undefined; // [S3] `/resume`: a parked solo run of this session, run as a turn (`solo-commands.ts`)
}

export { bindApprovalAnswers } from "./approvals.js";
export type { ApprovalTarget, GateAnswer } from "./approvals.js";

export class ReplEngine {
  readonly #deps: ReplEngineDeps;
  readonly #renderer: TranscriptRenderer;
  readonly #decoder = new KeyDecoder();
  readonly #interrupts: InterruptController;
  readonly budget: BudgetLedger;
  readonly approvals: ApprovalGate;
  readonly conversation: Conversation;

  #draft = "";
  #cursor = 0;
  #busy = false;
  #started = false;
  #queued: QueuedTurn[] = [];
  #abort: AbortController | undefined;
  #answer: ((answer: GateAnswer) => void) | undefined;
  /** Set while the open gate is an `ask_human` question: keystrokes build the answer line instead of y/n. */
  #question = false;
  #awaitingStepId: string | undefined;
  #runIds: string[] = [];
  /** Steps already gated this turn: the bus emits step_ AND run_awaiting_approval for one gate. */
  readonly #gated = new GateKeys(); // [S2] A3
  #selected = 0;
  /** Which (run, seat) pairs this session assembled a prompt for, so `/context` can ask about them. */
  readonly #context = new ContextTracker();
  /** Notices already on screen. A notice source repeats itself; the user should not have to. */
  readonly #shown = new Set<string>();

  constructor(deps: ReplEngineDeps) {
    this.#deps = deps;
    this.#renderer = new TranscriptRenderer({ theme: deps.theme, degraded: deps.degraded ?? false });
    this.budget = new BudgetLedger({
      capCents: deps.config.budget.daily_cap,
      perRunCapCents: deps.config.budget.per_run_cap,
      thresholds: deps.config.budget.alert_thresholds,
      openingCents: deps.openingCents ?? 0,
    });
    this.conversation = deps.conversation ?? new Conversation(historyLimits(deps.config));
    this.approvals = new ApprovalGate(deps.store, deps.companyId);
    this.#interrupts = new InterruptController({
      isBusy: () => this.#busy,
      abort: () => this.#abort?.abort(new Error(ABORT_REASON)),
      exit: (code) => deps.exit(code),
    });
  }

  // ── state a caller (or a test) can read ───────────────────────────────────

  get transcript(): string[] {
    return [...this.#renderer.lines];
  }
  get busy(): boolean {
    return this.#busy;
  }
  get draft(): string {
    return this.#draft;
  }
  /** Turns waiting behind the running one, oldest first. */
  get queued(): string[] {
    return this.#queued.map((turn) => turn.text);
  }
  get awaitingApproval(): boolean {
    return this.#answer !== undefined;
  }
  get context(): ReplContext {
    return buildReplContext(this.#deps, {
      budget: this.budget,
      approvals: this.approvals,
      runIds: this.#runIds,
      contextRuns: this.#context.runs(),
    });
  }

  /** Prints every notice the session owes that is not already on screen. */
  #drainNotices(): void {
    for (const line of unseenNotices(this.#deps.notices?.() ?? [], this.#shown)) {
      this.#emit(this.#renderer.push(this.#deps.theme.needsApproval(line)));
    }
  }

  #width(): number {
    return this.#deps.width ?? terminalWidth();
  }

  #emit(line: string): void {
    this.#deps.write(line);
  }

  #render(lines: readonly string[]): void {
    for (const line of lines) this.#emit(line);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Prints the degraded banner (once) and restores anything left pending by a restart. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    if (this.#deps.degraded === true) this.#render(renderDegradedBanner(this.#deps.theme, this.#width(), this.#deps.degradedNotice));
    const restored = await this.approvals.restore();
    for (const approval of restored) {
      this.#emit(this.#deps.theme.meta("An approval from an earlier session is still pending:"));
      this.#render(
        renderApprovalCard(
          { id: approval.id, action: approval.action, reason: approval.reason, agentRole: "restored" },
          this.#deps.theme,
          this.#width(),
        ),
      );
    }
    // A session hook that was skipped at start-up is owed to the user before the first prompt.
    this.#drainNotices();
    this.#emit(this.#deps.theme.meta(NEWLINE_HINT));
    this.prompt();
  }

  prompt(): void {
    this.#emit(this.#deps.theme.accent(PROMPT) + this.#draft);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  /** Feeds raw bytes from stdin. Returns the keys it acted on, for diagnostics. */
  feed(chunk: string): KeyEvent[] {
    const events = this.#decoder.push(chunk);
    for (const event of events) this.handleKey(event);
    return events;
  }

  /** Resolves a held ESC. The caller arms this on the escape timeout. */
  flushKeys(): void {
    for (const event of this.#decoder.flush()) this.handleKey(event);
  }

  handleKey(event: KeyEvent): void {
    if (event.type === "interrupt") {
      this.#interrupts.press();
      return;
    }
    if (this.awaitingApproval) {
      this.#answerKey(event);
      return;
    }
    if (this.#busy && event.type === "eof") return; // a stray EOF must not kill a running turn

    switch (event.type) {
      case "text":
        this.#insert(event.value);
        return;
      case "backspace":
        if (this.#cursor > 0) {
          this.#draft = this.#draft.slice(0, this.#cursor - 1) + this.#draft.slice(this.#cursor);
          this.#cursor -= 1;
        }
        return;
      case "newline":
        this.#insert("\n");
        return;
      case "submit":
        void this.#submitDraft();
        return;
      case "eof":
        this.#deps.exit(0);
        return;
      case "escape":
        this.#selected = 0;
        return;
      case "key":
        if (event.name === "down") this.#selected += 1;
        if (event.name === "up") this.#selected = Math.max(0, this.#selected - 1);
        return;
      default:
        return;
    }
  }

  #insert(text: string): void {
    this.#draft = this.#draft.slice(0, this.#cursor) + text + this.#draft.slice(this.#cursor);
    this.#cursor += text.length;
  }

  /** The dropdown for the token under the cursor, or an empty list when it is closed. */
  dropdown(): string[] {
    const completion = autocomplete(this.#draft, this.#cursor, commandNames());
    if (!completion.open || completion.matches.length === 0) return [];
    const selected = this.#selected % completion.matches.length;
    return renderDropdown(completion.matches, selected, this.#deps.theme, this.#width());
  }

  /** Accepts the highlighted completion into the draft. */
  acceptCompletion(): boolean {
    const completion = autocomplete(this.#draft, this.#cursor, commandNames());
    if (!completion.open || completion.matches.length === 0) return false;
    const choice = completion.matches[this.#selected % completion.matches.length]!;
    const applied = applyCompletion(this.#draft, this.#cursor, choice);
    this.#draft = applied.line;
    this.#cursor = applied.cursor;
    this.#selected = 0;
    return true;
  }

  async #submitDraft(): Promise<void> {
    const text = this.#draft.trim();
    this.#draft = "";
    this.#cursor = 0;
    this.#selected = 0;
    if (text === "") {
      this.prompt();
      return;
    }
    await this.submit(text);
  }

  #answerKey(event: KeyEvent): void {
    if (this.#question) {
      // The answer is a typed line: edited like the draft, sent on Enter, never empty.
      if (event.type === "text") this.#insert(event.value);
      else if (event.type === "backspace" && this.#cursor > 0) {
        this.#draft = this.#draft.slice(0, this.#cursor - 1) + this.#draft.slice(this.#cursor);
        this.#cursor -= 1;
      } else if (event.type === "submit" && this.#draft.trim() !== "") {
        const answer = this.#draft.trim();
        this.#draft = "";
        this.#cursor = 0;
        this.#answer?.({ answer });
      }
      return;
    }
    if (event.type !== "text") return;
    const key = event.value.trim().toLowerCase();
    if (key === "y") this.#answer?.("approved");
    if (key === "n") this.#answer?.("rejected");
  }

  // ── a turn ────────────────────────────────────────────────────────────────

  /**
   * One turn: a slash command, or a real orchestrated run. Never a canned string.
   * While a run is in flight, `/stop` interrupts it and a second objective follows
   * `repl.double_text_policy`; the promise settles when the turn it caused has run.
   */
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (text === "") return;
    if (text === STOP_COMMAND) {
      if (this.#busy) this.#interrupts.press();
      else this.#emit(this.#renderer.push(this.#deps.theme.meta("Nothing is running.")));
      return;
    }
    const resumed = /^\/resume(\s|$)/.test(text) && !this.#busy ? this.#deps.resume?.() : undefined; // [S3]
    if (resumed !== undefined) return this.#runTurn(text, resumed);
    if (text.startsWith("/")) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      this.#emit(await runCommand(name ?? "", args, this.context));
      this.prompt();
      return;
    }
    if (!this.#busy) {
      await this.#runTurn(text);
      return;
    }
    await this.#whileBusy(text);
  }

  /** Applies the double-texting policy to an objective that arrived mid-run. */
  #whileBusy(text: string): Promise<void> {
    const policy = doubleTextPolicy(this.#deps.config);
    if (policy === "reject") {
      this.#emit(this.#renderer.push(this.#deps.theme.meta(BUSY_STATUS_LINE)));
      return Promise.resolve();
    }
    if (policy === "interrupt") {
      // The new objective supersedes the run and anything queued behind it.
      for (const stale of this.#queued.splice(0)) stale.settle();
      this.#interrupts.press();
    } else {
      this.#emit(this.#renderer.push(this.#deps.theme.meta(`Queued for the next turn: ${text}`)));
    }
    return new Promise<void>((settle, fail) => this.#queued.push({ text, settle, fail }));
  }

  /** Runs the next queued turn, if any, once the current one has fully settled. */
  #drainQueued(): void {
    const next = this.#queued.shift();
    if (!next) return;
    // A failure belongs to whoever submitted the queued turn, exactly as for a direct one.
    void Promise.resolve().then(() => this.#runTurn(next.text)).then(next.settle, next.fail);
  }

  async #runTurn(objective: string, source: ReplRunner = this.#deps.runner): Promise<void> {
    // The cap refuses the turn before a single token is bought. Thresholds still only warn.
    const stop = this.budget.exceeded();
    if (stop !== null) {
      this.#emit(this.#renderer.push(this.budget.stopLine(stop, this.#deps.theme)));
      this.prompt();
      this.#drainQueued();
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#busy = true;
    this.#gated.clear();
    this.budget.beginRun();
    const history = this.conversation.history();
    this.conversation.recordUser(objective);
    const outcome = new TurnOutcome();
    let interrupted = false;
    try {
      for await (const event of source({ objective, signal: abort.signal, history })) { // [S3] the turn's runner, or a /resume
        outcome.observe(event);
        this.#render(this.#renderer.handle(event));
        await this.#afterEvent(event, abort.signal);
        if (abort.signal.aborted) {
          interrupted = true;
          break;
        }
      }
    } catch (error) {
      // Branch on the SIGNAL, never on error.name: an abort carrying a reason produces
      // an error that is not named AbortError.
      if (abort.signal.aborted) interrupted = true;
      else throw error;
    } finally {
      if (abort.signal.aborted) interrupted = true;
      this.#busy = false;
      this.#abort = undefined;
      // An interrupted turn is persisted as interrupted, never threaded as this turn's answer.
      this.conversation.recordAssistant(
        outcome.content,
        interrupted ? { ...outcome.metadata(), status: "interrupted" } : outcome.metadata(),
      );
      if (interrupted) this.#emit(this.#renderer.push(this.#deps.theme.meta("Interrupted. The run was stopped.")));
      // A hook is skipped during a CALL, so the notices are read after the turn, not before it.
      this.#drainNotices();
      this.prompt();
      this.#drainQueued();
    }
  }

  async #afterEvent(event: OrcEvent, signal: AbortSignal): Promise<void> {
    this.#context.observe(event);
    if (event.kind === "run_start" && !this.#runIds.includes(event.runId)) {
      this.#runIds.push(event.runId);
      await rememberRun(this.#deps.store, this.#deps.companyId, event.runId);
    }
    if (event.kind === "step_end" || event.kind === "consolidate_end") {
      const cost = event.step?.costCents;
      if (typeof cost === "number" && Number.isInteger(cost)) {
        this.budget.record(cost);
        for (const threshold of this.budget.takeCrossed()) {
          this.#emit(this.#renderer.push(this.budget.warningLine(threshold, this.#deps.theme)));
        }
        const stop = this.budget.exceeded();
        if (stop !== null) {
          this.#emit(this.#renderer.push(this.budget.stopLine(stop, this.#deps.theme)));
          this.#abort?.abort(new Error(ABORT_REASON));
        }
      }
    }
    // [S2] Council A3: one card per HELD CALL, not per step (`gate-keys.ts`).
    if (this.#gated.admit(event)) await this.#blockOnApproval(event, signal);
  }

  /** Opens the card and refuses ordinary input until the human answers it. A question reads one typed line instead of y/n. */
  async #blockOnApproval(event: OrcEvent, signal: AbortSignal): Promise<void> {
    const identity = identityForRole(event.step?.agentRole ?? "specialized");
    const question = questionFromEvent(event);
    const record = await this.approvals.open({
      action: question?.question ?? event.step?.title ?? event.detail ?? "an action",
      reason: question?.context ?? event.detail ?? "this step requires a human decision",
      agentRole: identity.role,
      stepId: event.step?.id,
    });
    this.#awaitingStepId = event.step?.id;
    this.#question = question !== undefined;
    if (question) {
      const theme = this.#deps.theme;
      this.#render([
        theme.needsApproval(`${GLYPHS.needsApproval} QUESTION FROM ${identity.displayName}`),
        ...renderQuestion(question).split("\n").map((line) => `  ${theme.body(line)}`),
        theme.needsApproval("  Type your answer and press Enter."),
      ]);
    } else {
      this.#render(renderApprovalCard({ id: record.id, action: record.action, reason: record.reason, agentRole: identity.displayName }, this.#deps.theme, this.#width()));
    }

    const answer = await new Promise<GateAnswer | "aborted">((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      const onAbort = (): void => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      this.#answer = (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
    });
    this.#answer = undefined;
    this.#question = false;

    if (answer === "aborted") return;
    await this.approvals.answer(record.id, typeof answer === "object" ? "approved" : answer);
    await this.#deps.onApprovalAnswer?.(event.runId, this.#awaitingStepId, answer);
    this.#awaitingStepId = undefined;
    const line = typeof answer === "object" ? `Answer to ${record.id}: ${answer.answer}` : `Approval ${record.id} ${answer}.`;
    this.#emit(this.#renderer.push(this.#deps.theme.body(line)));
  }
}
