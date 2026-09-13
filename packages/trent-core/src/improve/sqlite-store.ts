/**
 * `ImproveStorePort` on the standalone SQLite database, through the same Prisma connection the
 * rest of the store uses (`PrismaStore.improve()`).
 *
 * Why raw SQL and not the generated client: the schema is DERIVED from `apps/web/prisma/schema.prisma`
 * (read-only), whose AgentTrace / SkillDraft / SelfImprovementIteration models predate the fleet
 * loop and carry no agent id, no ledger and no frontier. This module bootstraps what the loop needs
 * idempotently on first use: nullable columns added to the three existing tables (the app's client
 * never selects them, so it is unaffected) and three new tables: GepaFrontier, SkillLedger and
 * GateCache (content-addressed gate results, so a sweep never re-buys a measurement it has).
 *
 * Every write is a single bound statement; every read normalises the driver's typed columns
 * (DATETIME -> ISO string, BOOLEAN -> boolean, JSONB -> parsed) so callers see one row shape.
 */

import type {
  AgentTraceRow,
  DraftFilter,
  DraftPatch,
  GateCacheRow,
  GepaFrontierRow,
  ImproveArtifactKind,
  ImproveDraftStatus,
  ImproveLedgerAction,
  ImproveStorePort,
  IterationFilter,
  IterationRow,
  JsonObject,
  JsonValue,
  LedgerFilter,
  SkillDraftRow,
  SkillLedgerRow,
  TraceFilter,
} from "../store/StorePort.js";

/** The two raw-query primitives the store needs. `PrismaStore` supplies them from the client. */
export interface RawSql {
  execute(sql: string, ...args: unknown[]): Promise<number>;
  query<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]>;
}

type Row = Record<string, unknown>;

const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ["AgentTrace", "agentId", "TEXT"],
  ["AgentTrace", "skillApplied", "INTEGER NOT NULL DEFAULT 0"],
  ["SkillDraft", "agentId", "TEXT"],
  ["SkillDraft", "kind", "TEXT NOT NULL DEFAULT 'skill'"],
  ["SkillDraft", "contentHash", "TEXT"],
  ["SkillDraft", "triggers", "TEXT NOT NULL DEFAULT '[]'"],
  ["SkillDraft", "lastUsedAt", "TEXT"],
  ["SkillDraft", "retiredAt", "TEXT"],
  ["SelfImprovementIteration", "agentId", "TEXT"],
  ["SelfImprovementIteration", "inputHash", "TEXT"],
  ["SelfImprovementIteration", "verdicts", "TEXT"],
];

const NEW_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "GepaFrontier" (
    "companyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "frontier" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    PRIMARY KEY ("companyId", "agentId")
  )`,
  `CREATE TABLE IF NOT EXISTS "SkillLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "artifactKind" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "beforeHash" TEXT,
    "afterHash" TEXT,
    "before" TEXT,
    "after" TEXT,
    "iterationId" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "GateCache" (
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    PRIMARY KEY ("companyId", "key")
  )`,
  `CREATE INDEX IF NOT EXISTS "SkillLedger_company_artifact_idx" ON "SkillLedger" ("companyId", "artifactId")`,
  `CREATE INDEX IF NOT EXISTS "SkillLedger_company_iteration_idx" ON "SkillLedger" ("companyId", "iterationId")`,
  `CREATE INDEX IF NOT EXISTS "AgentTrace_company_agent_idx" ON "AgentTrace" ("companyId", "agentId", "taskType")`,
];

// --- Read-side normalisers ---------------------------------------------------------------------

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function json(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return value as JsonValue;
}

function stringArray(value: unknown): string[] {
  const parsed = json(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function traceRow(r: Row): AgentTraceRow {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    agentRole: String(r.agentRole),
    agentId: String(r.agentId ?? r.agentRole),
    runId: String(r.runId),
    taskType: String(r.taskType),
    stepTitle: String(r.stepTitle),
    status: String(r.status),
    toolCalls: stringArray(r.toolCalls),
    toolCallCount: Number(r.toolCallCount),
    critiqueVerdict: text(r.critiqueVerdict),
    improvement: text(r.improvement),
    evalScore: num(r.evalScore),
    costCents: Number(r.costCents ?? 0),
    latencyMs: num(r.latencyMs),
    humanCorrected: bool(r.humanCorrected),
    skillApplied: bool(r.skillApplied),
    createdAt: iso(r.createdAt),
  };
}

function draftRow(r: Row): SkillDraftRow {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    agentId: String(r.agentId ?? ""),
    taskType: String(r.taskType),
    kind: String(r.kind ?? "skill") as ImproveArtifactKind,
    status: String(r.status) as ImproveDraftStatus,
    content: String(r.content),
    contentHash: String(r.contentHash ?? ""),
    triggers: stringArray(r.triggers),
    createdAt: iso(r.createdAt),
    promotedAt: isoOrNull(r.promotedAt),
    lastUsedAt: isoOrNull(r.lastUsedAt),
    retiredAt: isoOrNull(r.retiredAt),
  };
}

function iterationRow(r: Row): IterationRow {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    agentId: String(r.agentId ?? ""),
    taskType: String(r.taskType),
    candidateId: text(r.candidateId),
    candidateKind: text(r.candidateKind) as ImproveArtifactKind | null,
    score: num(r.score),
    delta: num(r.delta),
    decision: String(r.decision),
    triggers: stringArray(r.triggers),
    blockedBy: text(r.blockedBy),
    inputHash: text(r.inputHash),
    verdicts: json(r.verdicts),
    createdAt: iso(r.createdAt),
  };
}

function ledgerRow(r: Row): SkillLedgerRow {
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    agentId: String(r.agentId),
    taskType: String(r.taskType),
    action: String(r.action) as ImproveLedgerAction,
    artifactKind: String(r.artifactKind) as ImproveArtifactKind,
    artifactId: String(r.artifactId),
    beforeHash: text(r.beforeHash),
    afterHash: text(r.afterHash),
    before: text(r.before),
    after: text(r.after),
    iterationId: text(r.iterationId),
    actor: String(r.actor),
    createdAt: iso(r.createdAt),
  };
}

/** Builds `WHERE a = ? AND b = ?` from the defined entries only. */
function where(pairs: Array<[column: string, value: unknown]>): { sql: string; args: unknown[] } {
  const defined = pairs.filter(([, value]) => value !== undefined);
  if (defined.length === 0) return { sql: "", args: [] };
  return {
    sql: ` WHERE ${defined.map(([column]) => `"${column}" = ?`).join(" AND ")}`,
    args: defined.map(([, value]) => value),
  };
}

export class SqliteImproveStore implements ImproveStorePort {
  #ready: Promise<void> | undefined;

  constructor(private readonly raw: RawSql) {}

  /** Idempotent bootstrap, once per store instance. */
  private ensure(): Promise<void> {
    this.#ready ??= this.bootstrap();
    return this.#ready;
  }

  private async bootstrap(): Promise<void> {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const columns = await this.raw.query<{ name: string }>(`PRAGMA table_info("${table}")`);
      if (columns.some((c) => c.name === column)) continue;
      await this.raw.execute(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${ddl}`);
    }
    for (const statement of NEW_TABLES) await this.raw.execute(statement);
  }

  async appendTrace(row: AgentTraceRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "AgentTrace" ("id","companyId","runId","taskType","agentRole","agentId","stepTitle","status","toolCalls","toolCallCount","critiqueVerdict","improvement","evalScore","costCents","latencyMs","humanCorrected","skillApplied","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.companyId,
      row.runId,
      row.taskType,
      row.agentRole,
      row.agentId,
      row.stepTitle,
      row.status,
      JSON.stringify(row.toolCalls),
      row.toolCallCount,
      row.critiqueVerdict,
      row.improvement,
      row.evalScore,
      row.costCents,
      row.latencyMs,
      row.humanCorrected ? 1 : 0,
      row.skillApplied ? 1 : 0,
      row.createdAt,
    );
  }

  async listTraces(companyId: string, filter: TraceFilter = {}): Promise<AgentTraceRow[]> {
    await this.ensure();
    const w = where([["companyId", companyId], ["agentId", filter.agentId], ["taskType", filter.taskType]]);
    const rows = await this.raw.query<Row>(`SELECT * FROM "AgentTrace"${w.sql} ORDER BY "createdAt" DESC, "id" DESC`, ...w.args);
    return rows.map(traceRow);
  }

  async tracesByRun(runId: string): Promise<AgentTraceRow[]> {
    await this.ensure();
    const rows = await this.raw.query<Row>(`SELECT * FROM "AgentTrace" WHERE "runId" = ? ORDER BY "createdAt" ASC, "id" ASC`, runId);
    return rows.map(traceRow);
  }

  async countTracesByAgent(companyId: string): Promise<Record<string, number>> {
    await this.ensure();
    const rows = await this.raw.query<{ agentId: unknown; n: unknown }>(
      `SELECT COALESCE("agentId","agentRole") AS "agentId", COUNT(*) AS "n" FROM "AgentTrace" WHERE "companyId" = ? GROUP BY COALESCE("agentId","agentRole")`,
      companyId,
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[String(r.agentId)] = Number(r.n);
    return counts;
  }

  async createDraft(row: SkillDraftRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "SkillDraft" ("id","companyId","agentId","taskType","kind","status","content","contentHash","triggers","createdAt","promotedAt","lastUsedAt","retiredAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.companyId,
      row.agentId,
      row.taskType,
      row.kind,
      row.status,
      row.content,
      row.contentHash,
      JSON.stringify(row.triggers),
      row.createdAt,
      row.promotedAt,
      row.lastUsedAt,
      row.retiredAt,
    );
  }

  async getDraft(id: string): Promise<SkillDraftRow | null> {
    await this.ensure();
    const rows = await this.raw.query<Row>(`SELECT * FROM "SkillDraft" WHERE "id" = ?`, id);
    return rows[0] ? draftRow(rows[0]) : null;
  }

  async updateDraft(id: string, patch: DraftPatch): Promise<SkillDraftRow> {
    await this.ensure();
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`"${column}" = ?`);
      args.push(value);
    }
    if (sets.length > 0) {
      const changed = await this.raw.execute(`UPDATE "SkillDraft" SET ${sets.join(", ")} WHERE "id" = ?`, ...args, id);
      if (changed === 0) throw new Error(`draft ${id} not found`);
    }
    const row = await this.getDraft(id);
    if (!row) throw new Error(`draft ${id} not found`);
    return row;
  }

  async listDrafts(companyId: string, filter: DraftFilter = {}): Promise<SkillDraftRow[]> {
    await this.ensure();
    const w = where([
      ["companyId", companyId],
      ["agentId", filter.agentId],
      ["taskType", filter.taskType],
      ["kind", filter.kind],
      ["status", filter.status],
    ]);
    const rows = await this.raw.query<Row>(`SELECT * FROM "SkillDraft"${w.sql} ORDER BY "createdAt" DESC, "id" DESC`, ...w.args);
    return rows.map(draftRow);
  }

  async appendIteration(row: IterationRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "SelfImprovementIteration" ("id","companyId","agentId","taskType","candidateId","candidateKind","score","delta","decision","triggers","blockedBy","inputHash","verdicts","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.companyId,
      row.agentId,
      row.taskType,
      row.candidateId,
      row.candidateKind,
      row.score,
      row.delta,
      row.decision,
      JSON.stringify(row.triggers),
      row.blockedBy,
      row.inputHash,
      row.verdicts === null ? null : JSON.stringify(row.verdicts),
      row.createdAt,
    );
  }

  async getIteration(id: string): Promise<IterationRow | null> {
    await this.ensure();
    const rows = await this.raw.query<Row>(`SELECT * FROM "SelfImprovementIteration" WHERE "id" = ?`, id);
    return rows[0] ? iterationRow(rows[0]) : null;
  }

  async listIterations(companyId: string, filter: IterationFilter = {}): Promise<IterationRow[]> {
    await this.ensure();
    const w = where([["companyId", companyId], ["agentId", filter.agentId], ["taskType", filter.taskType]]);
    const limit = filter.limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
    const rows = await this.raw.query<Row>(
      `SELECT * FROM "SelfImprovementIteration"${w.sql} ORDER BY "createdAt" DESC, "id" DESC${limit}`,
      ...w.args,
    );
    return rows.map(iterationRow);
  }

  async getFrontier(companyId: string, agentId: string): Promise<GepaFrontierRow | null> {
    await this.ensure();
    const rows = await this.raw.query<Row>(`SELECT * FROM "GepaFrontier" WHERE "companyId" = ? AND "agentId" = ?`, companyId, agentId);
    const r = rows[0];
    if (!r) return null;
    const parsed = json(r.frontier);
    return {
      companyId: String(r.companyId),
      agentId: String(r.agentId),
      frontier: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {},
      updatedAt: iso(r.updatedAt),
    };
  }

  async putFrontier(row: GepaFrontierRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "GepaFrontier" ("companyId","agentId","frontier","updatedAt") VALUES (?,?,?,?)
       ON CONFLICT("companyId","agentId") DO UPDATE SET "frontier" = excluded."frontier", "updatedAt" = excluded."updatedAt"`,
      row.companyId,
      row.agentId,
      JSON.stringify(row.frontier),
      row.updatedAt,
    );
  }

  async appendLedger(row: SkillLedgerRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "SkillLedger" ("id","companyId","agentId","taskType","action","artifactKind","artifactId","beforeHash","afterHash","before","after","iterationId","actor","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      row.companyId,
      row.agentId,
      row.taskType,
      row.action,
      row.artifactKind,
      row.artifactId,
      row.beforeHash,
      row.afterHash,
      row.before,
      row.after,
      row.iterationId,
      row.actor,
      row.createdAt,
    );
  }

  async listLedger(companyId: string, filter: LedgerFilter = {}): Promise<SkillLedgerRow[]> {
    await this.ensure();
    const w = where([
      ["companyId", companyId],
      ["agentId", filter.agentId],
      ["iterationId", filter.iterationId],
      ["artifactId", filter.artifactId],
    ]);
    const rows = await this.raw.query<Row>(`SELECT * FROM "SkillLedger"${w.sql} ORDER BY "createdAt" ASC, "rowid" ASC`, ...w.args);
    return rows.map(ledgerRow);
  }

  async getGateCache(companyId: string, key: string): Promise<GateCacheRow | null> {
    await this.ensure();
    const rows = await this.raw.query<Row>(`SELECT * FROM "GateCache" WHERE "companyId" = ? AND "key" = ?`, companyId, key);
    const r = rows[0];
    if (!r) return null;
    return { companyId: String(r.companyId), key: String(r.key), value: json(r.value), createdAt: iso(r.createdAt) };
  }

  async putGateCache(row: GateCacheRow): Promise<void> {
    await this.ensure();
    await this.raw.execute(
      `INSERT INTO "GateCache" ("companyId","key","value","createdAt") VALUES (?,?,?,?)
       ON CONFLICT("companyId","key") DO UPDATE SET "value" = excluded."value", "createdAt" = excluded."createdAt"`,
      row.companyId,
      row.key,
      JSON.stringify(row.value),
      row.createdAt,
    );
  }
}
