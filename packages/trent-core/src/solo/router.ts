/**
 * [S2] The solo router: one solo runner per CONVERSATION, and the one object a surface drives.
 *
 * A solo runner is one conversation: one session port, one frozen system prefix, and a new run on
 * it abandons whatever it had parked (`runner.ts`). A surface serves many conversations from one
 * runtime (every chat thread of the gateway, every A2A context), so a runner per process would share
 * one conversation between strangers and let a message on thread B abandon thread A's held call
 * (council A2). The router keeps a runner per conversation:
 *
 *   session       a profile session id (the REPL's; a gateway thread's): its transcript IS the
 *                 conversation, and the runner is its only writer (A1, `session-store.ts`);
 *   conversation  an in-process key (an A2A context);
 *   neither       a one-off (`trent run`, a cron job, the heartbeat): a runner of its own, dropped
 *                 once its run ends with nothing parked. A one-off refuses every hold (B8).
 *
 * It is itself a `SoloRunner`: `approve`/`reject`/`answer`/`resume` find the runner that owns the
 * run id, so the REPL's `bindApprovalAnswers` and the gateway's approval link take it unchanged.
 * `answer` releases only a question (`ask_human`, `clarify`): text never approves a side effect.
 *
 * Every frame of every run is handed, in order, to the runtime's sinks (the bus hooks the approval
 * link, traces, alerts and telemetry ride on, the trace sink, the audit rows: A12, B4) before the
 * surface sees it, and each sink is flushed when the stream ends. A decision that lands on a run
 * nobody is streaming is a LATE decision: the stream ended at the gate, so `onLateDecision`
 * listeners are told the run id and a driver resumes the run (the gateway posts its reply).
 */
import { EXIT, TrentError } from "../errors/index.js";
import type { AgentRunInput } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { isQuestionAdapter, type SoloHoldPolicy } from "./hold-policy.js";
import type { SoloParkedCall, SoloRunner } from "./types.js";

/** The conversation a runner serves, as the router hands it to `create`. */
export interface SoloConversation {
  /** `session:<id>`, `conversation:<key>` or `once:<n>`. */
  readonly key: string;
  /** Set for a profile session: the transcript the runner reads and writes. */
  readonly sessionId?: string;
  /** What a held call does in this conversation (`hold-policy.ts`). */
  readonly holds: SoloHoldPolicy;
  /** The surface the conversation's spend and audit rows are charged to. */
  readonly surface?: string;
  /** [CF] C15.1: a gateway thread's platform id, from the run that opened the conversation; the prompt's last section. */
  readonly platform?: string; // [CF]
}

export interface SoloRouteInput extends AgentRunInput {
  /** A profile session id. The runner is the only writer of that transcript. */
  readonly session?: string;
  /** An in-process conversation key (an A2A context). */
  readonly conversation?: string;
  /** Overrides the router's policy when this run opens its conversation. */
  readonly holds?: SoloHoldPolicy;
  readonly surface?: string;
  /** [CF] C15.1: the platform a gateway thread is on (`InboundMessage.platform`). Read when the run opens its conversation. */
  readonly platform?: string; // [CF]
}

/** A consumer of every frame: `BusHook` satisfies it, and so does a bare trace sink. */
export interface SoloFrameSink {
  sink(event: OrcEvent): void;
  flush?(): Promise<void>;
}

export type SoloDecision = "approved" | "rejected" | "answered";

export interface SoloRouterOptions {
  /** Builds the runner for a conversation the first time the conversation runs. */
  readonly create: (conversation: SoloConversation) => SoloRunner;
  readonly sinks?: readonly SoloFrameSink[];
  /** The policy of a session or conversation run that names none. Default `deny`; a one-off is always `deny` unless the run says otherwise. */
  readonly holds?: SoloHoldPolicy;
  /** Told of every decision the router passed on (the audit rows name the human's). */
  readonly onDecision?: (runId: string, stepId: string, decision: SoloDecision) => void;
  /**
   * The parks an earlier process saved (`session-store.ts` `savedSoloParks`). Read once, on the first
   * call that needs a run this process did not start, and each one's session is opened, so after a
   * restart `parked()`, a decision and `resume(runId)` find it.
   */
  readonly saved?: () => ReadonlyArray<{ readonly runId: string; readonly sessionId: string }>;
  /** The ids of approval rows still pending. A parked call whose row left this set was decided elsewhere (`trent approvals`). */
  readonly pendingApprovals?: () => ReadonlySet<string> | undefined;
}

export interface SoloRouter extends SoloRunner {
  run(input: SoloRouteInput): AsyncIterable<OrcEvent>;
  /** Called with the run id when a decision lands on a run no reader is streaming. Returns the unsubscribe. */
  onLateDecision(listener: (runId: string) => void): () => void;
  /** The conversation a live or parked run belongs to. */
  conversationOf(runId: string): SoloConversation | undefined;
  /**
   * The parked runs whose approval row was decided outside this router (`trent approvals approve`),
   * each announced once to the `onLateDecision` listeners so a driver resumes it. Returns their ids.
   */
  sweep(): string[];
}

const TERMINAL: ReadonlySet<OrcEvent["kind"]> = new Set(["run_done", "run_failed", "run_cancelled"]);

export function createSoloRouter(options: SoloRouterOptions): SoloRouter {
  const sinks = options.sinks ?? [];
  const entries = new Map<string, { readonly runner: SoloRunner; readonly conversation: SoloConversation }>();
  /** Run id -> conversation key, from the run's first frame until its terminal one. */
  const owners = new Map<string, string>();
  /** Run ids a reader is pulling right now: a decision on one of these continues that stream. */
  const streaming = new Set<string>();
  const listeners = new Set<(runId: string) => void>();
  /** Runs already announced as decided late, so a sweep never announces one twice. */
  const announced = new Set<string>();
  let oneOffs = 0;
  let adopted = false;

  function open(input: SoloRouteInput): SoloConversation {
    const surface = { ...(input.surface === undefined ? {} : { surface: input.surface }), ...(input.platform === undefined ? {} : { platform: input.platform }) }; // [CF] and the platform
    if (input.session !== undefined && input.session !== "") {
      return { key: `session:${input.session}`, sessionId: input.session, holds: input.holds ?? options.holds ?? "deny", ...surface };
    }
    if (input.conversation !== undefined && input.conversation !== "") {
      return { key: `conversation:${input.conversation}`, holds: input.holds ?? options.holds ?? "deny", ...surface };
    }
    oneOffs += 1;
    return { key: `once:${String(oneOffs)}`, holds: input.holds ?? "deny", ...surface };
  }

  function entryFor(conversation: SoloConversation) {
    const existing = entries.get(conversation.key);
    if (existing !== undefined) return existing;
    const entry = { runner: options.create(conversation), conversation };
    entries.set(conversation.key, entry);
    return entry;
  }

  /** After a restart: open every session an earlier process parked a run in, once. */
  function adoptSaved(): void {
    if (adopted || options.saved === undefined) return;
    adopted = true;
    let saved: ReadonlyArray<{ readonly runId: string; readonly sessionId: string }> = [];
    try {
      saved = options.saved();
    } catch {
      // An unreadable index costs the restart path, never a live conversation.
    }
    for (const park of saved) {
      const conversation: SoloConversation = { key: `session:${park.sessionId}`, sessionId: park.sessionId, holds: options.holds ?? "deny" };
      entryFor(conversation);
      if (!owners.has(park.runId)) owners.set(park.runId, conversation.key);
    }
  }

  const owning = (runId: string) => {
    adoptSaved();
    const key = owners.get(runId);
    return key === undefined ? undefined : entries.get(key);
  };

  function announce(runId: string): void {
    announced.add(runId);
    for (const listener of listeners) {
      try {
        listener(runId);
      } catch {
        // A driver that throws is its own failure; the decision already landed.
      }
    }
  }

  function share(event: OrcEvent): void {
    for (const sink of sinks) {
      try {
        sink.sink(event);
      } catch {
        // A sink is an observer: one that throws must not end the run it is watching.
      }
    }
  }

  /** The stream, observed: ownership, the sinks, and the one-off's release. */
  async function* observe(key: string, stream: AsyncIterable<OrcEvent>): AsyncGenerator<OrcEvent> {
    let runId: string | undefined;
    let ended = false;
    try {
      for await (const event of stream) {
        if (runId === undefined && event.runId !== "") {
          runId = event.runId;
          owners.set(runId, key);
          streaming.add(runId);
        }
        if (TERMINAL.has(event.kind)) ended = true;
        share(event);
        yield event;
      }
    } finally {
      if (runId !== undefined) {
        streaming.delete(runId);
        if (ended) {
          owners.delete(runId);
          announced.delete(runId);
        }
      }
      for (const sink of sinks) await sink.flush?.().catch(() => undefined);
      const entry = entries.get(key);
      // Runs of this conversation that are neither live nor parked were abandoned by a newer run.
      if (entry !== undefined) {
        const parked = new Set(entry.runner.parked().map((call) => call.runId));
        for (const [id, owner] of owners) if (owner === key && !streaming.has(id) && !parked.has(id)) owners.delete(id);
        if (key.startsWith("once:") && parked.size === 0) entries.delete(key);
      }
    }
  }

  async function decide(runId: string, stepId: string, decision: SoloDecision, apply: (runner: SoloRunner) => Promise<boolean>): Promise<boolean> {
    const entry = owning(runId);
    if (entry === undefined) return false;
    const decided = await apply(entry.runner);
    if (!decided) return false;
    options.onDecision?.(runId, stepId, decision);
    if (!streaming.has(runId)) announce(runId);
    return true;
  }

  async function* resume(runId: string, signal: AbortSignal | undefined): AsyncGenerator<OrcEvent> {
    adoptSaved();
    const key = owners.get(runId);
    const entry = key === undefined ? undefined : entries.get(key);
    if (key === undefined || entry === undefined) {
      throw new TrentError({ code: EXIT.USAGE, operation: "solo.resume", message: `no parked solo run ${runId} in this process`, target: runId });
    }
    yield* observe(key, entry.runner.resume(runId, signal === undefined ? {} : { signal }));
  }

  function parked(): SoloParkedCall[] {
    adoptSaved();
    return [...entries.values()].flatMap(({ runner }) => runner.parked());
  }

  return {
    run(input) {
      const conversation = open(input);
      const { runner } = entryFor(conversation);
      return observe(conversation.key, runner.run({ objective: input.objective, ...(input.signal === undefined ? {} : { signal: input.signal }) }));
    },
    approve: (runId, stepId) => decide(runId, stepId, "approved", (runner) => runner.approve(runId, stepId)),
    reject: (runId, stepId) => decide(runId, stepId, "rejected", (runner) => runner.reject(runId, stepId)),
    answer(runId, stepId, text) {
      return decide(runId, stepId, "answered", async (runner) => {
        // Text is an answer to a question and nothing else: a held side effect is never released by it (council B2).
        const held = runner.parked().find((call) => call.runId === runId && call.stepId === stepId);
        return held !== undefined && isQuestionAdapter(held.adapter) ? runner.answer(runId, stepId, text) : false;
      });
    },
    resume: (runId, input = {}) => resume(runId, input.signal),
    parked,
    onLateDecision(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    conversationOf: (runId) => owning(runId)?.conversation,
    sweep() {
      const pending = options.pendingApprovals?.();
      if (pending === undefined) return [];
      const due = parked()
        .filter((call) => call.approvalId !== undefined && !pending.has(call.approvalId) && !announced.has(call.runId) && !streaming.has(call.runId))
        .map((call) => call.runId);
      for (const runId of due) announce(runId);
      return due;
    },
  };
}
