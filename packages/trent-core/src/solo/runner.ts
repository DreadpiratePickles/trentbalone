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
 * run through `resume`.
 *
 * [S1.1] Council review:
 *   B1  every run is bound to the conversation's taint (`governance/provenance.ts` SessionTaint):
 *       the policy ring and the untrusted sources outlive the run, are saved with the session after
 *       every tool result and restored when the next runner opens it. Only a new session clears it.
 *   B2  `answer()` releases an `ask_human` / `clarify` hold and nothing else.
 *   B9  a park is saved with the session BEFORE its gate frames (`park.ts`), so a restart lists it
 *       in `parked()` and `resume(runId)` continues it after a decision: `approve` here, or the
 *       row decided by `trent approvals`. A park that cannot be rebuilt, or that a new run on the
 *       session supersedes, is abandoned out loud: its approval row is marked abandoned and the
 *       conversation gets one line saying the call did not run. Never a silent loss.
 *
 * [S3] Continuity: compaction before a run over its threshold (C5) and on `compact()`, prefix untouched
 * (`compaction.ts`); the skills index in the stable tier, invoked bodies in the context tier (`skills.ts`);
 * `delegate_task` through the driving run's route (`delegate-route.ts`); turns opened as seat `trent` and
 * `note()` for a `/rollback` (A10); a decision taken while the reader holds a re-raised gate continues it.
 */
import crypto from "node:crypto";
import type { AgentRunInput } from "../agent-runner/index.js";
import { EXIT, TrentError } from "../errors/index.js";
import { assembleContext, type ContextBlock } from "../fleet-memory/tiers.js";
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import { bindSessionTaint, createSessionTaint, snapshotSessionTaint, unbindSessionTaint, type SessionTaint } from "../governance/provenance.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { record as toRecord } from "../tools/action.js";
import { CARD_ADAPTER_NAMES, sharedHumanAnswers } from "../tools/human/index.js";
import { SoloEvents, clip, stopVerdict, type SoloStep } from "./events.js";
import { loadSoloState, parkRecordOf } from "./park.js";
import { assembleTurnContext, buildSystemPrompt, historyMessages, mergeRoles, readSoloPersona, renderToolResult, renderTurnOpening } from "./prompt.js";
import { boundRowOf } from "./holds.js";
import { driveTurn, gateFrames, type TurnDeps, type TurnState } from "./turn.js";
import { createSoloCompactor } from "./compaction.js"; // [S3]
import { bindRunDelegation } from "./delegate-route.js"; // [S3]
import { invokedSkillOf, invokedSkillsBlock, skillsIndexBlock } from "./skills.js"; // [S3]
import {
  DEFAULT_SOLO_MAX_TOOL_CALLS,
  DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS,
  DEFAULT_SOLO_OUTPUT_RESERVE_TOKENS,
  SOLO_SEAT,
  type SoloMessage,
  type SoloParkRecord,
  type SoloParkedCall,
  type SoloRunner,
  type SoloRunnerDeps,
} from "./types.js";

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

interface LiveRun {
  readonly state: TurnState;
  readonly objective: string;
}

const SUPERSEDED = "a new message started another run on this conversation";

export function createSoloRunner(deps: SoloRunnerDeps): SoloRunner {
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultId;
  const config = deps.config ?? {};
  const humanAnswers = deps.humanAnswers ?? sharedHumanAnswers;
  const resultCap = positiveInt(config.maxToolResultChars) ?? DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS;
  const window = positiveInt(config.contextWindowTokens);

  let prefix: SessionPrefix | undefined;
  /** Runs in flight or parked in this process, by run id. A run leaves when it reaches a terminal frame. */
  const runs = new Map<string, LiveRun>();
  /** Runs whose stream is being read right now: only one reader may drive a run. */
  const streaming = new Set<string>();
  /** [S1.1] Every parked run of the conversation, this process's and those saved by an earlier one. */
  const parks = new Map<string, SoloParkRecord>();
  let taint: SessionTaint | undefined;
  /** [S3] The skills `skill_view` loaded in this conversation, saved with the taint. */
  let invoked: string[] = [];

  /** [S1.1] The saved state, read once, on first use. */
  function sessionTaint(): SessionTaint {
    if (taint === undefined) {
      const saved = loadSoloState(deps.state);
      taint = createSessionTaint(saved.taint);
      for (const park of saved.parked) parks.set(park.runId, park);
      invoked = [...(saved.invokedSkills ?? [])]; // [S3]
    }
    return taint;
  }

  function persist(): void {
    if (deps.state === undefined) return;
    deps.state.save({ version: 1, taint: snapshotSessionTaint(sessionTaint()), parked: [...parks.values()], ...(invoked.length === 0 ? {} : { invokedSkills: [...invoked] }) }); // [S3] invoked
  }

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
      ...(config.responseFormat === undefined ? {} : { responseFormat: config.responseFormat }),
    },
    payload: deps.companyId === undefined ? {} : { companyId: deps.companyId },
    maxToolResultChars: resultCap,
    ...(window === undefined ? {} : { budget: { windowTokens: window, reserveTokens: positiveInt(config.maxTokens) ?? DEFAULT_SOLO_OUTPUT_RESERVE_TOKENS } }),
    ...(deps.tools.bindings === undefined ? {} : { bindings: deps.tools.bindings }),
    afterCall: (state) => {
      // [S3] A `skill_view` of a skill joins the conversation's invoked set, before the state is saved.
      const skill = invokedSkillOf(state.toolCalls.at(-1));
      if (skill !== undefined && !invoked.includes(skill)) invoked.push(skill);
      persist();
    },
    onPark: (state) => {
      const objective = runs.get(state.runId)?.objective ?? state.step.title;
      parks.set(state.runId, parkRecordOf(state, { objective, parkedAt: clock().toISOString(), ...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }) }));
      persist();
    },
  };

  // [S3] Compaction: the automatic path before a run, and `compact()`; its model calls on the meter as their own run.
  const compactor = createSoloCompactor({ deps, ...(window === undefined ? {} : { windowTokens: window }), now: clock, newId, taint: () => sessionTaint(), parked: () => new Set(parks.keys()), busy: () => streaming.size > 0 });

  async function prefixFor(objective: string, runId: string, history: readonly SoloMessage[]): Promise<{ session: SessionPrefix; context: readonly ContextBlock[] }> {
    const tiers = await deps.memory({ runId, objective, history });
    if (prefix === undefined) {
      const index = skillsIndexBlock(deps.skills); // [S3] names and one line each, frozen with the prefix
      const blocks = [...tiers.stable, ...(index === undefined ? [] : [index])].map((block) => ({ ...block, tier: "stable" as const }));
      const text = assembleContext(blocks, { ceilingChars: config.ceilingChars ?? Number.NaN }).text;
      prefix = { system: buildSystemPrompt({ persona: readSoloPersona(deps.profileDir), stable: text, adapters: deps.tools.adapters }), stable: blocks };
    }
    return { session: prefix, context: tiers.context };
  }

  /** [S1.1] The approval row of an abandoned park is marked abandoned; false when there was none to mark. */
  function abandonRow(approvalId: string | undefined, why: string): boolean {
    if (approvalId === undefined) return false;
    if (deps.approvals !== undefined) return deps.approvals.abandon(approvalId, why);
    return deps.tools.bindings?.decide(approvalId, "denied", `abandoned: ${why}`) !== undefined;
  }

  /** [S1.1] Drops a park out loud: the row is marked, and the conversation gets one line saying the call did not run. */
  async function abandon(park: SoloParkRecord, why: string): Promise<string> {
    runs.delete(park.runId);
    parks.delete(park.runId);
    const call = park.pending[0] ?? { adapter: park.held.adapter, action: park.held.action };
    abandonRow(park.approvalId, why);
    const approval = park.approvalId === undefined ? "its approval" : `approval ${park.approvalId}`;
    const line = toRecord(call.adapter, call.action, "blocked", `not run: ${why}; ${call.adapter} was waiting for ${approval}, which is now abandoned. Ask again if it is still wanted.`);
    await deps.session.append([{ role: "tool", content: renderToolResult(line, resultCap), runId: park.runId, record: line }]);
    persist();
    return line.summary;
  }

  async function* drive(runId: string, signal: AbortSignal | undefined): AsyncGenerator<OrcEvent> {
    const run = runs.get(runId);
    if (run === undefined) return;
    const { state } = run;
    streaming.add(runId);
    deps.meter.open?.(runId, run.objective);
    bindSessionTaint(runId, sessionTaint());
    // [S3] item 4: this run's `delegate_task` delegates through its own route while it drives.
    const unbindDelegation = bindRunDelegation({ deps, runId, state, maxToolCalls: turnDeps.maxToolCalls, taint: () => sessionTaint(), signal });
    try {
      for (;;) {
        // A decision is being acted on: the park it answered is spent.
        if (state.held !== undefined && state.decision !== undefined && parks.delete(runId)) persist();
        const end = yield* driveTurn(state, turnDeps, signal);
        if (end === "ended") {
          runs.delete(runId);
          if (parks.delete(runId)) persist();
          return;
        }
        // The reader pulled past the gate. A decision made meanwhile continues this stream.
        if (state.decision === undefined) return;
        if (state.decision === "approved") yield state.events.approved(state.step);
      }
    } finally {
      streaming.delete(runId);
      unbindSessionTaint(runId);
      unbindDelegation?.(); // [S3]
      // A parked run's spend reaches the ledger now; `resume` opens the scope again.
      deps.meter.close?.(runId);
    }
  }

  async function* start(input: AgentRunInput): AsyncGenerator<OrcEvent> {
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (objective === "") throw new TrentError({ code: EXIT.USAGE, operation: "solo.run", message: "the objective is empty, so there is nothing to run" });
    sessionTaint();
    // A run no reader is driving was dropped mid-stream; a parked one is superseded, out loud.
    for (const runId of [...runs.keys()]) if (!streaming.has(runId) && !parks.has(runId)) runs.delete(runId);
    for (const park of [...parks.values()]) if (!streaming.has(park.runId)) await abandon(park, SUPERSEDED);
    deps.checkpoints?.beginTurn(SOLO_SEAT); // [S3] A10: every row this turn ledgers is seat `trent`
    // [S3] C5: over its threshold, the conversation is compacted before this turn's first model call.
    const compacted = compactor.auto ? await compactor.compact(false) : undefined;

    const runId = newId("solo");
    const startedAt = clock().toISOString();
    const step: SoloStep = { id: `${runId}-${SOLO_SEAT}`, title: clip(objective), startedAt };
    const history = await deps.session.history();
    const { session, context: blocks } = await prefixFor(objective, runId, history);
    const skills = invokedSkillsBlock(deps.skills, invoked); // [S3] the loaded bodies, after recall: the last trimmed
    const context = assembleTurnContext({
      now: clock(),
      blocks: skills === undefined ? blocks : [...blocks, skills],
      stable: session.stable,
      ...(deps.workspace === undefined ? {} : { workspace: deps.workspace }),
      ...(config.ceilingChars === undefined ? {} : { ceilingChars: config.ceilingChars }),
    });
    await deps.session.append([{ role: "user", content: objective, runId }]);

    const opening = renderTurnOpening(context.text, objective);
    const messages = [{ role: "system" as const, content: session.system }, ...mergeRoles([...historyMessages(history, resultCap), { role: "user", content: opening }])];
    const state: TurnState = {
      runId,
      step,
      events: new SoloEvents(runId, objective, clock),
      messages,
      opening,
      openedAt: messages.length,
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
      heldApprovalId: undefined,
      decision: undefined,
      approved: [],
    };
    runs.set(runId, { state, objective });
    yield state.events.runStart(startedAt);
    yield state.events.stepStart(step);
    const compactionNote = compactor.noteFor(compacted); // [S3]
    if (compactionNote !== undefined) yield state.events.note(step, compactionNote);
    yield* drive(runId, input.signal);
  }

  /** [S1.1] A park saved by an earlier process, as a live run again; a string says why it cannot be. */
  async function rebuild(park: SoloParkRecord): Promise<LiveRun | string> {
    const pending = [];
    for (const call of park.pending) {
      const adapter = deps.tools.adapters.find((candidate) => candidate.name === call.adapter);
      if (adapter === undefined) return `the tool "${call.adapter}" is not in this build`;
      pending.push({ adapter, tool: toolNameOf(call.action), action: call.action });
    }
    const history = await deps.session.history();
    const index = history.findIndex((message) => message.runId === park.runId && message.role === "user");
    if (index === -1) return "the session no longer holds the run's opening message";
    const { session } = await prefixFor(park.objective, park.runId, history.slice(0, index));
    const messages = [{ role: "system" as const, content: session.system }, ...mergeRoles([...historyMessages(history.slice(0, index), resultCap), ...park.runMessages])];
    const state: TurnState = {
      runId: park.runId,
      step: { id: park.stepId, title: clip(park.objective), startedAt: park.startedAt },
      events: new SoloEvents(park.runId, park.objective, clock),
      messages,
      opening: park.runMessages[0]?.content ?? park.objective,
      openedAt: messages.length - (park.runMessages.length - 1),
      toolCalls: [...park.toolCalls],
      pending,
      results: [...park.results],
      callsMade: park.callsMade,
      costCents: park.costCents,
      tokens: park.tokens,
      model: park.model,
      failures: new Map(),
      malformedStreak: 0,
      held: park.held,
      heldApprovalId: park.approvalId,
      decision: park.decision,
      approved: park.approved.map((entry) => ({ ...entry })),
    };
    return { state, objective: park.objective };
  }

  async function* resume(runId: string, signal: AbortSignal | undefined): AsyncGenerator<OrcEvent> {
    sessionTaint();
    let run = runs.get(runId);
    const park = parks.get(runId);
    if (run === undefined && park !== undefined) {
      const rebuilt = await rebuild(park);
      if (typeof rebuilt === "string") {
        const line = await abandon(park, `the process restarted and the parked run could not be rebuilt: ${rebuilt}`);
        const events = new SoloEvents(runId, park.objective, clock);
        const step: SoloStep = { id: park.stepId, title: clip(park.objective), startedAt: park.startedAt };
        yield events.stepEnd(step, "failed", { tokens: park.tokens, costCents: park.costCents, ...(park.model === undefined ? {} : { model: park.model }) });
        yield events.runFailed(stopVerdict(`the parked run could not be rebuilt after a restart: ${rebuilt}. ${line}`, park.costCents));
        return;
      }
      runs.set(runId, rebuilt);
      run = rebuilt;
    }
    if (run === undefined || run.state.held === undefined) {
      throw new TrentError({ code: EXIT.USAGE, operation: "solo.resume", message: `no parked solo run ${runId} in this process`, target: runId });
    }
    if (streaming.has(runId)) {
      throw new TrentError({ code: EXIT.USAGE, operation: "solo.resume", message: `solo run ${runId} is still being streamed; its decision continues that stream`, target: runId });
    }
    const { state } = run;
    // [S1.1] No decision here: the row itself may have been decided (`trent approvals approve|reject`).
    if (state.decision === undefined) {
      const call = state.pending[0];
      const row = call === undefined ? undefined : boundRowOf(state, deps.tools.bindings, call);
      if (row?.status === "approved") state.decision = "approved";
      else if (row?.status === "denied") state.decision = "rejected";
    }
    if (state.decision === undefined) {
      yield* gateFrames(state);
      // [S3] A decision taken while the reader held the re-raised gate (the REPL's `/resume` card) continues this stream.
      if (state.decision === undefined) return;
    }
    if (state.decision === "approved") yield state.events.approved(state.step);
    yield* drive(runId, signal);
  }

  /** Where a decision lands: the live run, else the park an earlier process saved. */
  const decide = (runId: string, stepId: string, decision: "approved" | "rejected"): boolean => {
    sessionTaint();
    const state = runs.get(runId)?.state;
    const park = parks.get(runId);
    if (state !== undefined && (state.step.id !== stepId || state.held === undefined)) return false;
    if (state === undefined && (park === undefined || park.stepId !== stepId)) return false;
    if (state !== undefined) state.decision = decision;
    if (park !== undefined) {
      parks.set(runId, { ...park, decision });
      persist();
    }
    return true;
  };

  /** The adapter of the call a run is held on, live or saved. */
  const heldAdapter = (runId: string): string | undefined => runs.get(runId)?.state.pending[0]?.adapter.name ?? parks.get(runId)?.pending[0]?.adapter;

  return {
    run: (input) => start(input),
    approve: async (runId, stepId) => decide(runId, stepId, "approved"),
    reject: async (runId, stepId) => decide(runId, stepId, "rejected"),
    async answer(runId, stepId, text) {
      sessionTaint();
      // [S1.1] B2: text answers a question and nothing else; a held side effect is never released by it.
      const adapter = heldAdapter(runId);
      if (adapter === undefined || !CARD_ADAPTER_NAMES.includes(adapter)) return false;
      if (!decide(runId, stepId, "approved")) return false;
      // Where `ask_human` reads it on the replay (`tools/human`).
      humanAnswers.put(runId, stepId, text);
      return true;
    },
    resume: (runId, input = {}) => resume(runId, input.signal),
    parked: (): SoloParkedCall[] => {
      sessionTaint();
      return [...parks.values()].flatMap((park) => {
        const call = park.pending[0];
        if (call === undefined) return [];
        return [{ runId: park.runId, stepId: park.stepId, adapter: call.adapter, action: call.action, summary: park.held.summary, ...(park.approvalId === undefined ? {} : { approvalId: park.approvalId }) }];
      });
    },
    compact: (options = {}) => compactor.compact(options.force === true), // [S3] `/compact`
    // [S3] A10: what a `/rollback` undid, told to the conversation by its only writer.
    async note(text) {
      sessionTaint();
      if (text.trim() !== "") await deps.session.append([{ role: "system", content: text.trim() }]);
    },
  };
}
