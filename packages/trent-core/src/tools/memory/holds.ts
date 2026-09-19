/**
 * [C5] The hold path for a memory write made from untrusted context.
 *
 * `governance/provenance.ts` decides that a write is untrusted; this module is where the write
 * WAITS. It goes onto the approval path that already exists — the durable `ApprovalRow` in
 * `<profile>/gateway.json` (`gateway/store/GatewayStore.ts`), the same rows `trent doctor` and the
 * heartbeat's fleet-state block already count and the same rows a chat button resolves. Nothing
 * new is invented to hold one entry, and a hold therefore survives the process that made it.
 *
 * Approving replays the seat's OWN action against the memory adapter, with one change: the entry
 * text carries `[provenance: untrusted via <tools>]`. That marker is the point. The entry lands in
 * a block every seat loads next run, so the block itself has to say that this line came from a web
 * page rather than from the founder — otherwise the approval launders the provenance exactly the
 * way a sub-agent's summary does (research section 4, trust escalation).
 */
import path from "node:path";
import crypto from "node:crypto";
import { FileGatewayStore, type ApprovalRow } from "../../gateway/store/GatewayStore.js";
import type { Provenance, ToolCallRecord } from "../types.js";
import type { MemoryAdapter } from "./index.js";

/** The action a held row gates, as stored in `ApprovalRow.details`. */
export interface HeldWriteDetails extends Record<string, unknown> {
  readonly adapter: string;
  readonly action: string;
  readonly sources: readonly string[];
  readonly provenance: Provenance;
  readonly stepId?: string;
}

export interface HeldWriteRow extends Omit<ApprovalRow, "details"> {
  readonly details: HeldWriteDetails;
}

export const HELD_WRITE_ACTION = "memory write from untrusted context";

function storeFor(profileDir: string): FileGatewayStore {
  return new FileGatewayStore(path.join(profileDir, "gateway.json"));
}

function isHeldWrite(row: ApprovalRow): row is HeldWriteRow {
  const details = row.details as Partial<HeldWriteDetails>;
  return typeof details?.action === "string" && Array.isArray(details.sources) && details.provenance === "untrusted";
}

/** The provenance marker appended to every entry an approved untrusted write lands. */
export function provenanceMarker(sources: readonly string[]): string {
  return `[provenance: untrusted via ${sources.join(", ")}]`;
}

/**
 * The seat's action with the marker appended to every entry it would write. The action is
 * `<tool> <json>`; the JSON is re-serialised so a hand-written spacing cannot change what lands.
 */
export function heldWriteAction(action: string, sources: readonly string[]): string {
  const brace = action.indexOf("{");
  const marker = provenanceMarker(sources);
  if (brace === -1) return `${action.trim()} ${marker}`;
  const head = action.slice(0, brace).trim();
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(action.slice(brace)) as Record<string, unknown>;
  } catch {
    return `${action.trim()} ${marker}`;
  }
  const annotate = (value: unknown): unknown => (typeof value === "string" && value.trim() !== "" ? `${value.trim()} ${marker}` : value);
  if (typeof args.content === "string") args = { ...args, content: annotate(args.content) };
  if (Array.isArray(args.operations)) {
    args = {
      ...args,
      operations: args.operations.map((op) =>
        op && typeof op === "object" ? { ...(op as Record<string, unknown>), content: annotate((op as Record<string, unknown>).content) } : op,
      ),
    };
  }
  return `${head} ${JSON.stringify(args)}`.trim();
}

export interface HoldMemoryWriteInput {
  readonly profileDir: string;
  readonly adapter: string;
  readonly action: string;
  readonly sources: readonly string[];
  /** The seat that made the call; `ApprovalRow.agentId`. */
  readonly seat?: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly now?: () => Date;
}

export interface HeldWrite {
  readonly id: string;
  /** One line for the seat's tool result, naming the row so a founder can find it. */
  readonly line: string;
}

export function holdMemoryWrite(input: HoldMemoryWriteInput): HeldWrite {
  const now = (input.now ?? (() => new Date()))();
  const id = `appr_${String(now.getTime())}_${crypto.randomBytes(3).toString("hex")}`;
  const details: HeldWriteDetails = {
    adapter: input.adapter,
    action: input.action,
    sources: [...input.sources],
    provenance: "untrusted",
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
  };
  const row: ApprovalRow = {
    id,
    nonce: crypto.randomBytes(4).toString("hex"),
    agentId: input.seat ?? "orchestrator",
    action: HELD_WRITE_ACTION,
    details,
    status: "pending",
    createdAt: now.toISOString(),
    deliveredTo: [],
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    kind: "approval",
  };
  storeFor(input.profileDir).mutate((state) => {
    state.approvals[id] = row;
  });
  return { id, line: `Held as ${id}; approve it to write the entry tagged ${provenanceMarker(input.sources)}.` };
}

/** Every pending held write in this profile, oldest first. */
export function listHeldMemoryWrites(profileDir: string): HeldWriteRow[] {
  return Object.values(storeFor(profileDir).snapshot().approvals)
    .filter((row): row is HeldWriteRow => row.status === "pending" && row.action === HELD_WRITE_ACTION && isHeldWrite(row))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type HeldWriteFailure = { ok: false; reason: "unknown" | "not_pending" | "not_a_held_write" };

export type ApproveHeldWriteResult = { ok: true; record: ToolCallRecord; provenance: Provenance; row: HeldWriteRow } | HeldWriteFailure;

export interface ApproveHeldWriteInput {
  readonly profileDir: string;
  readonly id: string;
  /**
   * The UNWRAPPED memory adapter (`FleetMemoryHook.memory`). Approving must not re-enter the
   * provenance gate that held the write, or the approval would hold itself.
   */
  readonly memory: Pick<MemoryAdapter, "execute">;
  readonly decidedBy?: string;
}

function decide(profileDir: string, id: string, decision: "approved" | "denied", decidedBy: string): HeldWriteRow | HeldWriteFailure {
  return storeFor(profileDir).mutate((state) => {
    const row = state.approvals[id];
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.action !== HELD_WRITE_ACTION || !isHeldWrite(row)) return { ok: false, reason: "not_a_held_write" } as const;
    if (row.status !== "pending") return { ok: false, reason: "not_pending" } as const;
    row.status = decision;
    row.decidedAt = new Date().toISOString();
    row.decidedBy = decidedBy;
    return structuredClone(row) as HeldWriteRow;
  });
}

/** Applies a held write: the row is decided first, so a crash mid-write cannot replay the entry. */
export async function approveHeldMemoryWrite(input: ApproveHeldWriteInput): Promise<ApproveHeldWriteResult> {
  const decided = decide(input.profileDir, input.id, "approved", input.decidedBy ?? "human");
  if ("ok" in decided) return decided;
  const action = heldWriteAction(decided.details.action, decided.details.sources);
  const result = await input.memory.execute(action, {});
  return { ok: true, record: { ...result, provenance: "untrusted" }, provenance: "untrusted", row: decided };
}

export function denyHeldMemoryWrite(input: { profileDir: string; id: string; decidedBy?: string }): { ok: true; row: HeldWriteRow } | HeldWriteFailure {
  const decided = decide(input.profileDir, input.id, "denied", input.decidedBy ?? "human");
  return "ok" in decided ? decided : { ok: true, row: decided };
}

/**
 * [W3.1] One held write as a surface lists it. A founder deciding this row needs three facts and
 * not the raw action: what KIND of write it is (the adapter — a memory entry or a skill edit),
 * which seat made it, and which untrusted tools its content is derived from. Both surfaces read
 * this one function, so `trent approvals list` and `/approvals` cannot describe a row differently.
 */
export interface HeldWriteSummary {
  readonly id: string;
  /** The adapter the write was made through: `memory`, `skills`. */
  readonly kind: string;
  /** The tool the seat actually called, e.g. `memory` or `skill_manage`. */
  readonly tool: string;
  readonly seat: string;
  /** The untrusted tools this write's content came from; `holdMemoryWrite`'s `sources`. */
  readonly tools: readonly string[];
  readonly createdAt: string;
  readonly runId: string | null;
}

export function summariseHeldWrite(row: HeldWriteRow): HeldWriteSummary {
  return {
    id: row.id,
    kind: row.details.adapter,
    tool: row.details.action.trim().split(/\s+/)[0] ?? row.details.adapter,
    seat: row.agentId,
    tools: [...row.details.sources],
    createdAt: row.createdAt,
    runId: row.runId ?? null,
  };
}

/**
 * [W3.1] The process's held-write session: the profile whose `gateway.json` holds the rows, and
 * the UNWRAPPED memory adapter an approval replays against.
 *
 * A surface that decides a held write cannot invent either one. It must not build its own adapter
 * over a guessed profile (it would write into the wrong blocks) and it must not reach for the
 * wrapped one (replaying through the provenance gate that held the write would hold it again). So
 * the runtime that built both registers them here and `/approvals` looks them up, exactly the way
 * `/checkpoints` looks up the open ledger through `activeCheckpointSession()`.
 */
export interface HeldWriteSession {
  readonly profileDir: string;
  readonly memory: Pick<MemoryAdapter, "execute">;
}

let openSession: HeldWriteSession | undefined;

/** Opens the process's held-write session, replacing any previous one. */
export function openHeldWriteSession(session: HeldWriteSession): HeldWriteSession {
  openSession = session;
  return openSession;
}

export function activeHeldWriteSession(): HeldWriteSession | undefined {
  return openSession;
}

/**
 * Closes the session. With a session given, closes only that one: a runtime whose session has
 * already been replaced must not take the replacement down with it on cleanup.
 */
export function closeHeldWriteSession(session?: HeldWriteSession): void {
  if (session === undefined || openSession === session) openSession = undefined;
}
