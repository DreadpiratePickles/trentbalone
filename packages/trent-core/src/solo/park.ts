/**
 * [S1.1] What a solo conversation keeps between processes (council review B1, B9, chair ruling 6).
 *
 *   taint   the conversation's policy ring and untrusted sources (`governance/provenance.ts`
 *           SessionTaint), so a restart does not launder a secret read or an untrusted page;
 *   parked  every run parked on a held call: the run id, the session, the held approval id, the
 *           pending call and the run's OWN messages (its opening onwards, exactly as sent), so a new
 *           process can list it and, after a decision, continue it. The conversation before the run
 *           is rebuilt from the session itself, which the runner is the only writer of.
 *
 * The state is read back as untrusted JSON: each entry is validated on its own and one that does not
 * validate is dropped alone, so a damaged park cannot take the taint down with it.
 * `sessionStoreState` keeps it in the session store's sidecar (`sessions/SessionStore.ts`).
 */
import { z } from "zod";
import { PolicyClassSchema } from "../governance/policy-rules.js";
import type { GatewayMessage } from "../model-gateway/types.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { SoloSessionState, SoloStateStore, SoloParkRecord } from "./types.js";
import type { TurnState } from "./turn.js";

export const EMPTY_SOLO_STATE: SoloSessionState = { version: 1, taint: { calls: [], sources: [] }, parked: [] };

const RecordSchema = z
  .object({
    adapter: z.string(),
    action: z.string(),
    status: z.enum(["mocked", "completed", "needs_approval", "failed", "blocked"]),
    summary: z.string(),
    provenance: z.enum(["trusted", "untrusted"]).optional(),
  })
  .passthrough();

const MessageSchema = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });
const TaintCallSchema = z.object({ tool: z.string(), classes: z.array(PolicyClassSchema), at: z.number() });
const CallRefSchema = z.object({ adapter: z.string().min(1), action: z.string().min(1) });

const ParkSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().min(1),
  sessionId: z.string().optional(),
  objective: z.string(),
  startedAt: z.string(),
  parkedAt: z.string(),
  approvalId: z.string().optional(),
  held: RecordSchema,
  pending: z.array(CallRefSchema).min(1),
  runMessages: z.array(MessageSchema).min(1),
  results: z.array(z.string()),
  toolCalls: z.array(RecordSchema),
  callsMade: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  model: z.string().optional(),
  approved: z.array(CallRefSchema.extend({ approvalId: z.string().optional() })),
  decision: z.enum(["approved", "rejected"]).optional(),
});

function each<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The saved state, entry by entry: what validates is kept, the rest is dropped alone. */
export function parseSoloState(raw: unknown): SoloSessionState {
  if (raw === null || typeof raw !== "object") return EMPTY_SOLO_STATE;
  const value = raw as { taint?: { calls?: unknown; sources?: unknown }; parked?: unknown; invokedSkills?: unknown };
  const invoked = [...new Set(each(value.invokedSkills, z.string().min(1)))]; // [S3] skills on demand
  return {
    version: 1,
    taint: {
      calls: each(value.taint?.calls, TaintCallSchema),
      sources: each(value.taint?.sources, z.string()),
    },
    parked: each(value.parked, ParkSchema) as SoloParkRecord[],
    // [S3] Only when there is one, so a state without it reads back exactly as before.
    ...(invoked.length === 0 ? {} : { invokedSkills: invoked }),
  };
}

export function loadSoloState(store: SoloStateStore | undefined): SoloSessionState {
  return store === undefined ? EMPTY_SOLO_STATE : parseSoloState(store.load());
}

/** The state store over the session store's sidecar: beside the transcript, owner-only, removed with it. */
export function sessionStoreState(
  store: { readSoloState(sessionId: string): unknown; writeSoloState(sessionId: string, state: unknown): void },
  sessionId: string,
): SoloStateStore {
  return {
    load: () => store.readSoloState(sessionId),
    save: (state) => store.writeSoloState(sessionId, state),
  };
}

/** A parked run as it is saved: the turn state without the conversation that came before it. */
export function parkRecordOf(state: TurnState, input: { readonly sessionId?: string; readonly objective: string; readonly parkedAt: string }): SoloParkRecord {
  const runMessages: GatewayMessage[] = [{ role: "user", content: state.opening }, ...state.messages.slice(state.openedAt)];
  const held = state.held as ToolCallRecord;
  return {
    runId: state.runId,
    stepId: state.step.id,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    objective: input.objective,
    startedAt: state.step.startedAt,
    parkedAt: input.parkedAt,
    ...(state.heldApprovalId === undefined ? {} : { approvalId: state.heldApprovalId }),
    held,
    pending: state.pending.map((call) => ({ adapter: call.adapter.name, action: call.action })),
    runMessages,
    results: [...state.results],
    toolCalls: [...state.toolCalls],
    callsMade: state.callsMade,
    costCents: state.costCents,
    tokens: state.tokens,
    ...(state.model === undefined ? {} : { model: state.model }),
    approved: state.approved.map((entry) => ({ ...entry })),
    ...(state.decision === undefined ? {} : { decision: state.decision }),
  };
}
