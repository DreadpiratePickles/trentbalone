/**
 * In-memory `ImproveStorePort` for tests and for a runtime where bun:sqlite is unavailable.
 * Semantics mirror `sqlite-store.ts` exactly; `store-contract.ts` is the proof.
 */

import type {
  AgentTraceRow,
  AgentVersionFilter,
  AgentVersionPatch,
  AgentVersionRow,
  DraftFilter,
  DraftPatch,
  GateCacheRow,
  GepaFrontierRow,
  ImproveStorePort,
  IterationFilter,
  IterationRow,
  LedgerFilter,
  SkillDraftRow,
  SkillLedgerRow,
  TraceFilter,
} from "../store/StorePort.js";

const newestFirst = <T extends { createdAt: string }>(a: T, b: T): number => b.createdAt.localeCompare(a.createdAt);
const oldestFirst = <T extends { createdAt: string }>(a: T, b: T): number => a.createdAt.localeCompare(b.createdAt);

function frontierKey(companyId: string, agentId: string): string {
  return `${companyId}|${agentId}`;
}

export class InMemoryImproveStore implements ImproveStorePort {
  readonly #traces: AgentTraceRow[] = [];
  readonly #drafts = new Map<string, SkillDraftRow>();
  readonly #iterations: IterationRow[] = [];
  readonly #frontiers = new Map<string, GepaFrontierRow>();
  readonly #ledger: SkillLedgerRow[] = [];
  readonly #gateCache = new Map<string, GateCacheRow>();
  readonly #agentVersions = new Map<string, AgentVersionRow>();

  async createAgentVersion(row: AgentVersionRow): Promise<void> {
    if (this.#agentVersions.has(row.id)) throw new Error(`agent version ${row.id} already exists`);
    this.#agentVersions.set(row.id, structuredClone(row));
  }

  async getAgentVersion(id: string): Promise<AgentVersionRow | null> {
    const row = this.#agentVersions.get(id);
    return row ? structuredClone(row) : null;
  }

  async updateAgentVersion(id: string, patch: AgentVersionPatch): Promise<AgentVersionRow> {
    const row = this.#agentVersions.get(id);
    if (!row) throw new Error(`agent version ${id} not found`);
    const next: AgentVersionRow = { ...row };
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.iterationId !== undefined) next.iterationId = patch.iterationId;
    this.#agentVersions.set(id, next);
    return structuredClone(next);
  }

  async listAgentVersions(companyId: string, filter: AgentVersionFilter = {}): Promise<AgentVersionRow[]> {
    return [...this.#agentVersions.values()]
      .filter((v) => v.companyId === companyId)
      .filter((v) => filter.agentId === undefined || v.agentId === filter.agentId)
      .filter((v) => filter.label === undefined || v.label === filter.label)
      .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))
      .map((v) => structuredClone(v));
  }

  async appendTrace(row: AgentTraceRow): Promise<void> {
    this.#traces.push({ ...row, toolCalls: [...row.toolCalls], failureTags: [...(row.failureTags ?? [])] });
  }

  async listTraces(companyId: string, filter: TraceFilter = {}): Promise<AgentTraceRow[]> {
    return this.#traces
      .filter((t) => t.companyId === companyId)
      .filter((t) => filter.agentId === undefined || t.agentId === filter.agentId)
      .filter((t) => filter.taskType === undefined || t.taskType === filter.taskType)
      .sort(newestFirst)
      .map((t) => ({ ...t, toolCalls: [...t.toolCalls] }));
  }

  async tracesByRun(runId: string): Promise<AgentTraceRow[]> {
    return this.#traces.filter((t) => t.runId === runId).sort(oldestFirst).map((t) => ({ ...t }));
  }

  async countTracesByAgent(companyId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of this.#traces) {
      if (t.companyId !== companyId) continue;
      counts[t.agentId] = (counts[t.agentId] ?? 0) + 1;
    }
    return counts;
  }

  async createDraft(row: SkillDraftRow): Promise<void> {
    if (this.#drafts.has(row.id)) throw new Error(`draft ${row.id} already exists`);
    this.#drafts.set(row.id, { ...row, triggers: [...row.triggers] });
  }

  async getDraft(id: string): Promise<SkillDraftRow | null> {
    const row = this.#drafts.get(id);
    return row ? { ...row, triggers: [...row.triggers] } : null;
  }

  async updateDraft(id: string, patch: DraftPatch): Promise<SkillDraftRow> {
    const row = this.#drafts.get(id);
    if (!row) throw new Error(`draft ${id} not found`);
    const next: SkillDraftRow = { ...row };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.contentHash !== undefined) next.contentHash = patch.contentHash;
    if (patch.promotedAt !== undefined) next.promotedAt = patch.promotedAt;
    if (patch.lastUsedAt !== undefined) next.lastUsedAt = patch.lastUsedAt;
    if (patch.retiredAt !== undefined) next.retiredAt = patch.retiredAt;
    this.#drafts.set(id, next);
    return { ...next, triggers: [...next.triggers] };
  }

  async listDrafts(companyId: string, filter: DraftFilter = {}): Promise<SkillDraftRow[]> {
    return [...this.#drafts.values()]
      .filter((d) => d.companyId === companyId)
      .filter((d) => filter.agentId === undefined || d.agentId === filter.agentId)
      .filter((d) => filter.taskType === undefined || d.taskType === filter.taskType)
      .filter((d) => filter.kind === undefined || d.kind === filter.kind)
      .filter((d) => filter.status === undefined || d.status === filter.status)
      .sort(newestFirst)
      .map((d) => ({ ...d, triggers: [...d.triggers] }));
  }

  async appendIteration(row: IterationRow): Promise<void> {
    this.#iterations.push({ ...row, triggers: [...row.triggers] });
  }

  async getIteration(id: string): Promise<IterationRow | null> {
    const row = this.#iterations.find((i) => i.id === id);
    return row ? { ...row } : null;
  }

  async listIterations(companyId: string, filter: IterationFilter = {}): Promise<IterationRow[]> {
    const rows = this.#iterations
      .filter((i) => i.companyId === companyId)
      .filter((i) => filter.agentId === undefined || i.agentId === filter.agentId)
      .filter((i) => filter.taskType === undefined || i.taskType === filter.taskType)
      .sort(newestFirst)
      .map((i) => ({ ...i }));
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }

  async getFrontier(companyId: string, agentId: string): Promise<GepaFrontierRow | null> {
    const row = this.#frontiers.get(frontierKey(companyId, agentId));
    return row ? { ...row, frontier: structuredClone(row.frontier) } : null;
  }

  async putFrontier(row: GepaFrontierRow): Promise<void> {
    this.#frontiers.set(frontierKey(row.companyId, row.agentId), { ...row, frontier: structuredClone(row.frontier) });
  }

  async appendLedger(row: SkillLedgerRow): Promise<void> {
    this.#ledger.push({ ...row });
  }

  async listLedger(companyId: string, filter: LedgerFilter = {}): Promise<SkillLedgerRow[]> {
    return this.#ledger
      .filter((l) => l.companyId === companyId)
      .filter((l) => filter.agentId === undefined || l.agentId === filter.agentId)
      .filter((l) => filter.iterationId === undefined || l.iterationId === filter.iterationId)
      .filter((l) => filter.artifactId === undefined || l.artifactId === filter.artifactId)
      .sort(oldestFirst)
      .map((l) => ({ ...l }));
  }

  async getGateCache(companyId: string, key: string): Promise<GateCacheRow | null> {
    const row = this.#gateCache.get(`${companyId}|${key}`);
    return row ? { ...row, value: structuredClone(row.value) } : null;
  }

  async putGateCache(row: GateCacheRow): Promise<void> {
    this.#gateCache.set(`${row.companyId}|${row.key}`, { ...row, value: structuredClone(row.value) });
  }
}
