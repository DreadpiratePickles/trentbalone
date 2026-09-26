/**
 * [S1] `createSoloRunner`: the second implementation of the `AgentRunner` port.
 *
 * A run is one objective on the session's conversation: one step, seat `trent`, driven by
 * `turn.ts`, streamed as the orchestrator events every surface already reads (`events.ts`). The
 * system prefix is built on the first turn and then frozen for the session: persona, the stable
 * tier as it stood when the session opened (Hermes freezes its memory snapshot the same way, for
 * the prefix cache), the tool disclosure.
 *
 * A held call parks the run, exactly as a seat's gate parks one: both gate frames, then the stream
 * waits for its next pull. A decision made before that pull (the REPL blocks on the gate frame,
 * then calls `approve`) continues the SAME stream; with none, the stream ends with no terminal
 * frame, which the AgentRunner fold reads as `input-required`, and a later decision continues the
 * run through `resume`. A new run on the session abandons any run still parked; its hold stays in
 * the transcript as that call's last word.
 */
import crypto from "node:crypto";
import type { AgentRunInput } from "../agent-runner/index.js";
import { EXIT, TrentError } from "../errors/index.js";
import { assembleContext, type ContextBlock } from "../fleet-memory/tiers.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { sharedHumanAnswers } from "../tools/human/index.js";
import { SoloEvents, clip, type SoloStep } from "./events.js";
import { assembleTurnContext, buildSystemPrompt, historyMessages, mergeRoles, readSoloPersona, renderTurnOpening } from "./prompt.js";
import { driveTurn, gateFrames, type TurnDeps, type TurnState } from "./turn.js";
import { DEFAULT_SOLO_MAX_TOOL_CALLS, SOLO_SEAT, type SoloParkedCall, type SoloRunner, type SoloRunnerDeps } from "./types.js";

function defaultId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

interface SessionPrefix {
  readonly system: string;
  readonly stable: readonly ContextBlock[];
}

export function createSoloRunner(deps: SoloRunnerDeps): SoloRunner {
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultId;
  const config = deps.config ?? {};
  const humanAnswers = deps.humanAnswers ?? sharedHumanAnswers;
  const turnDeps: TurnDeps = {
    gateway: deps.gateway,
    adapters: deps.tools.adapters,
    session: deps.session,
    meter: deps.meter,
    maxToolCalls: positiveInt(config.maxToolCalls) ?? DEFAULT_SOLO_MAX_TOOL_CALLS,
    request: {
      role: "executor",
      ...(config.model === undefined || config.model === "" ? {} : { model: config.model }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    },
    payload: deps.companyId === undefined ? {} : { companyId: deps.companyId },
  };

  let prefix: SessionPrefix | undefined;
  /** Runs in flight or parked, by run id. A run leaves when it reaches a terminal frame. */
  const runs = new Map<string, { state: TurnState; objective: string }>();
  /** Runs whose stream is being read right now: only one reader may drive a run. */
  const streaming = new Set<string>();

  function prefixFor(stable: readonly ContextBlock[]): SessionPrefix {
    if (prefix === undefined) {
      const blocks = stable.map((block) => ({ ...block, tier: "stable" as const }));
      const text = assembleContext(blocks, { ceilingChars: config.ceilingChars ?? Number.NaN }).text;
      prefix = { system: buildSystemPrompt({ persona: readSoloPersona(deps.profileDir), stable: text, adapters: deps.tools.adapters }), stable: blocks };
    }
    return prefix;
  }

  async function* drive(runId: string, signal: AbortSignal | undefined): AsyncGenerator<OrcEvent> {
    const run = runs.get(runId);
    if (run === undefined) return;
    const { state } = run;
    streaming.add(runId);
    deps.meter.open?.(runId, run.objective);
    try {
      for (;;) {
        const end = yield* driveTurn(state, turnDeps, signal);
        if (end === "ended") {
          runs.delete(runId);
          return;
        }
        // The reader pulled past the gate. A decision made meanwhile continues this stream.
        if (state.decision === undefined) return;
        if (state.decision === "approved") yield state.events.approved(state.step);
      }
    } finally {
      streaming.delete(runId);
      // A parked run's spend reaches the ledger now; `resume` opens the scope again.
      deps.meter.close?.(runId);
    }
  }

  async function* start(input: AgentRunInput): AsyncGenerator<OrcEvent> {
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (objective === "") throw new TrentError({ code: EXIT.USAGE, operation: "solo.run", message: "the objective is empty, so there is nothing to run" });
    // A run no reader is driving is either parked (abandoned now) or was dropped mid-stream.
    for (const runId of [...runs.keys()]) if (!streaming.has(runId)) runs.delete(runId);
    deps.checkpoints?.beginTurn();

    const runId = newId("solo");
    const startedAt = clock().toISOString();
    const step: SoloStep = { id: `${runId}-${SOLO_SEAT}`, title: clip(objective), startedAt };
    const history = await deps.session.history();
    const tiers = await deps.memory({ runId, objective, history });
    const session = prefixFor(tiers.stable);
    const context = assembleTurnContext({
      now: clock(),
      blocks: tiers.context,
      stable: session.stable,
      ...(deps.workspace === undefined ? {} : { workspace: deps.workspace }),
      ...(config.ceilingChars === undefined ? {} : { ceilingChars: config.ceilingChars }),
    });
    await deps.session.append([{ role: "user", content: objective, runId }]);

    const state: TurnState = {
      runId,
      step,
      events: new SoloEvents(runId, objective, clock),
      messages: [{ role: "system", content: session.system }, ...mergeRoles([...historyMessages(history), { role: "user", content: renderTurnOpening(context.text, objective) }])],
      toolCalls: [],
      pending: [],
      results: [],
      callsMade: 0,
      costCents: 0,
      tokens: 0,
      model: undefined,
      failures: new Map(),
      malformedStreak: 0,
      held: undefined,
      decision: undefined,
    };
    runs.set(runId, { state, objective });
    yield state.events.runStart(startedAt);
    yield state.events.stepStart(step);
    yield* drive(runId, input.signal);
  }

  async function* resume(runId: string, signal: AbortSignal | undefined): AsyncGenerator<OrcEvent> {
    const run = runs.get(runId);
    if (run === undefined || run.state.held === undefined) {
      throw new TrentError({ code: EXIT.USAGE, operation: "solo.resume", message: `no parked solo run ${runId} in this process`, target: runId });
    }
    if (streaming.has(runId)) {
      throw new TrentError({ code: EXIT.USAGE, operation: "solo.resume", message: `solo run ${runId} is still being streamed; its decision continues that stream`, target: runId });
    }
    const { state } = run;
    if (state.decision === undefined) {
      yield* gateFrames(state);
      return;
    }
    if (state.decision === "approved") yield state.events.approved(state.step);
    yield* drive(runId, signal);
  }

  const decide = (runId: string, stepId: string, decision: "approved" | "rejected"): boolean => {
    const state = runs.get(runId)?.state;
    if (state === undefined || state.step.id !== stepId || state.held === undefined) return false;
    state.decision = decision;
    return true;
  };

  return {
    run: (input) => start(input),
    approve: async (runId, stepId) => decide(runId, stepId, "approved"),
    reject: async (runId, stepId) => decide(runId, stepId, "rejected"),
    async answer(runId, stepId, text) {
      const state = runs.get(runId)?.state;
      if (state === undefined || state.step.id !== stepId || state.held === undefined) return false;
      // Where `ask_human` reads it on the replay (`tools/human`), then released like any approval.
      humanAnswers.put(runId, stepId, text);
      return decide(runId, stepId, "approved");
    },
    resume: (runId, input = {}) => resume(runId, input.signal),
    parked: (): SoloParkedCall[] =>
      [...runs.values()].flatMap(({ state }) => {
        const call = state.pending[0];
        if (state.held === undefined || call === undefined) return [];
        return [{ runId: state.runId, stepId: state.step.id, adapter: call.adapter.name, action: call.action, summary: state.held.summary }];
      }),
  };
}
