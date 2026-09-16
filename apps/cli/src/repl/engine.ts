/**
 * The REPL engine: input, the streaming render loop, approvals, budget and interrupts,
 * with no terminal of its own. `index.ts` binds it to a real stdin/stdout; the tests
 * bind it to arrays, which is what makes the behaviour assertable.
 */

import { terminalWidth, type Theme } from "../ui/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { BUSY_STATUS_LINE, STOP_COMMAND, type DoubleTextPolicy } from "@trent/core/gateway/index.js";
import { TranscriptRenderer, identityForRole } from "./render.js";
import { BudgetLedger } from "./budget.js";
import { ApprovalGate, renderApprovalCard } from "./approvals.js";
import { runCommand, commandNames } from "./commands.js";
import { autocomplete, applyCompletion, renderDropdown } from "./autocomplete.js";
import { renderDegradedBanner } from "./degraded.js";
import { rememberRun } from "./memory.js";
import { KeyDecoder, NEWLINE_HINT, type KeyEvent } from "./keys.js";
import { ABORT_REASON, InterruptController } from "./interrupt.js";
import type { ReplConfig, ReplContext, ReplEgressStatus, ReplSandbox, ReplStore, ReplToolListing, ReplTraceStore } from "./types.js";

/** The prompt prefix. The mark is a mint dot; read the product name as `trent·`. */
export const PROMPT = "● ";

export { BUSY_STATUS_LINE };

/** `repl.double_text_policy`, read off the config slice; anything unrecognised is `enqueue`. */
function doubleTextPolicy(config: ReplConfig): DoubleTextPolicy {
  const repl = config.repl;
  const value = typeof repl === "object" && repl !== null ? (repl as { double_text_policy?: unknown }).double_text_policy : undefined;
  return value === "interrupt" || value === "reject" ? value : "enqueue";
}

/** A turn submitted while another was running, held until that one settles. */
interface QueuedTurn {
  text: string;
  settle: () => void;
  fail: (error: unknown) => void;
}

export interface ReplRunnerInput {
  objective: string;
  signal: AbortSignal;
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
  traces?: ReplTraceStore;
  width?: number;
  /** The registered toolset adapters, the sandbox they run in and the egress state, for `/tools` and `/status`. */
  tools?: readonly ReplToolListing[];
  sandbox?: ReplSandbox;
  egress?: ReplEgressStatus;
  /**
   * Told when the human answers, so the orchestrator can release the step. `runId` is the run the
   * gate belongs to — taken from the event itself, never from a side list (live proof, F5).
   */
  onApprovalAnswer?(runId: string, stepId: string | undefined, answer: "approved" | "rejected"): Promise<void> | void;
}

/** The two calls an approval answer needs. `Orchestrator` from `@trent/core` satisfies it. */
export interface ApprovalTarget {
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
}

/**
 * The `onApprovalAnswer` that releases a parked orchestrator step. Shared by `index.ts` and the
 * tests so the REPL's real approval path is the one under test. A gate with no step id (a
 * restored card from an earlier session) has nothing to release and is a no-op.
 */
export function bindApprovalAnswers(target: ApprovalTarget): NonNullable<ReplEngineDeps["onApprovalAnswer"]> {
  return async (runId, stepId, answer) => {
    if (stepId === undefined) return;
    if (answer === "approved") await target.approve(runId, stepId);
    else await target.reject(runId, stepId);
  };
}

const EMPTY_TRACES: ReplTraceStore = { query: async () => [], byRun: async () => [] };

export class ReplEngine {
  readonly #deps: ReplEngineDeps;
  readonly #renderer: TranscriptRenderer;
  readonly #decoder = new KeyDecoder();
  readonly #interrupts: InterruptController;
  readonly budget: BudgetLedger;
  readonly approvals: ApprovalGate;

  #draft = "";
  #cursor = 0;
  #busy = false;
  #started = false;
  #queued: QueuedTurn[] = [];
  #abort: AbortController | undefined;
  #answer: ((answer: "approved" | "rejected") => void) | undefined;
  #awaitingStepId: string | undefined;
  #runIds: string[] = [];
  /** Steps already gated this turn: the bus emits step_ AND run_awaiting_approval for one gate. */
  #gated = new Set<string>();
  #selected = 0;

  constructor(deps: ReplEngineDeps) {
    this.#deps = deps;
    this.#renderer = new TranscriptRenderer({ theme: deps.theme, degraded: deps.degraded ?? false });
    this.budget = new BudgetLedger({
      capCents: deps.config.budget.daily_cap,
      thresholds: deps.config.budget.alert_thresholds,
    });
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
    return {
      theme: this.#deps.theme,
      config: this.#deps.config,
      store: this.#deps.store,
      companyId: this.#deps.companyId,
      traces: this.#deps.traces ?? EMPTY_TRACES,
      budget: this.budget,
      approvals: this.approvals,
      degraded: this.#deps.degraded ?? false,
      runIds: [...this.#runIds],
      tools: this.#deps.tools,
      sandbox: this.#deps.sandbox,
      egress: this.#deps.egress,
    };
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
    if (this.#deps.degraded === true) this.#render(renderDegradedBanner(this.#deps.theme, this.#width()));
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

  async #runTurn(objective: string): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    this.#busy = true;
    this.#gated.clear();
    let interrupted = false;
    try {
      for await (const event of this.#deps.runner({ objective, signal: abort.signal })) {
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
      if (interrupted) this.#emit(this.#renderer.push(this.#deps.theme.meta("Interrupted. The run was stopped.")));
      this.prompt();
      this.#drainQueued();
    }
  }

  async #afterEvent(event: OrcEvent, signal: AbortSignal): Promise<void> {
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
      }
    }
    if (event.kind === "step_awaiting_approval" || event.kind === "run_awaiting_approval") {
      const key = `${event.runId}/${event.step?.id ?? event.at}`;
      if (this.#gated.has(key)) return;
      this.#gated.add(key);
      await this.#blockOnApproval(event, signal);
    }
  }

  /** Opens the card and refuses ordinary input until the human answers it. */
  async #blockOnApproval(event: OrcEvent, signal: AbortSignal): Promise<void> {
    const identity = identityForRole(event.step?.agentRole ?? "specialized");
    const record = await this.approvals.open({
      action: event.step?.title ?? event.detail ?? "an action",
      reason: event.detail ?? "this step requires a human decision",
      agentRole: identity.role,
      stepId: event.step?.id,
    });
    this.#awaitingStepId = event.step?.id;
    this.#render(
      renderApprovalCard(
        { id: record.id, action: record.action, reason: record.reason, agentRole: identity.displayName },
        this.#deps.theme,
        this.#width(),
      ),
    );

    const answer = await new Promise<"approved" | "rejected" | "aborted">((resolve) => {
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

    if (answer === "aborted") return;
    await this.approvals.answer(record.id, answer);
    await this.#deps.onApprovalAnswer?.(event.runId, this.#awaitingStepId, answer);
    this.#awaitingStepId = undefined;
    this.#emit(this.#renderer.push(this.#deps.theme.body(`Approval ${record.id} ${answer}.`)));
  }
}
