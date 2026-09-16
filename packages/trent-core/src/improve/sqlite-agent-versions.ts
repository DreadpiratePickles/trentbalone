/**
 * The `AgentVersion` table (T4.1) on the standalone SQLite database: the DDL `sqlite-store.ts`
 * bootstraps and the four statements it delegates to. Split out so that file stays under the
 * 500-line rule; the row shape is `AgentVersionRow` in `../store/StorePort.ts`.
 *
 * JSON columns (`model`, `toolsets`, `definition`) are stored as text and parsed on read; a row
 * written by an older build with a malformed column reads as its empty shape rather than throwing
 * in the middle of a listing.
 */

import type { AgentDefinition, AgentVersionFilter, AgentVersionLabel, AgentVersionPatch, AgentVersionRow } from "../store/StorePort.js";
import type { RawSql } from "./sqlite-store.js";

export const AGENT_VERSION_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "AgentVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "toolsets" TEXT NOT NULL,
    "skillsHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "iterationId" TEXT,
    "definition" TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AgentVersion_company_agent_version_idx" ON "AgentVersion" ("companyId", "agentId", "version")`,
];

type Row = Record<string, unknown>;

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function modelOf(value: unknown): { provider: string; model: string } {
  const m = parsed(value) as { provider?: unknown; model?: unknown } | null;
  return { provider: String(m?.provider ?? ""), model: String(m?.model ?? "") };
}

function definitionOf(value: unknown): AgentDefinition {
  const d = parsed(value) as Partial<AgentDefinition> | null;
  return {
    prompt: String(d?.prompt ?? ""),
    model: modelOf(JSON.stringify(d?.model ?? {})),
    toolsets: Array.isArray(d?.toolsets) ? d.toolsets.map(String) : [],
    skills: Array.isArray(d?.skills) ? d.skills.map((s) => ({ slug: String(s.slug), content: String(s.content) })) : [],
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

export function agentVersionRow(r: Row): AgentVersionRow {
  const toolsets = parsed(r.toolsets);
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    agentId: String(r.agentId),
    version: Number(r.version),
    promptHash: String(r.promptHash),
    model: modelOf(r.model),
    toolsets: Array.isArray(toolsets) ? toolsets.map(String) : [],
    skillsHash: String(r.skillsHash),
    label: String(r.label) as AgentVersionLabel,
    createdAt: iso(r.createdAt),
    iterationId: r.iterationId === null || r.iterationId === undefined ? null : String(r.iterationId),
    definition: definitionOf(r.definition),
  };
}

export async function insertAgentVersion(raw: RawSql, row: AgentVersionRow): Promise<void> {
  await raw.execute(
    `INSERT INTO "AgentVersion" ("id","companyId","agentId","version","promptHash","model","toolsets","skillsHash","label","createdAt","iterationId","definition")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id,
    row.companyId,
    row.agentId,
    row.version,
    row.promptHash,
    JSON.stringify(row.model),
    JSON.stringify(row.toolsets),
    row.skillsHash,
    row.label,
    row.createdAt,
    row.iterationId,
    JSON.stringify(row.definition),
  );
}

export async function selectAgentVersion(raw: RawSql, id: string): Promise<AgentVersionRow | null> {
  const rows = await raw.query<Row>(`SELECT * FROM "AgentVersion" WHERE "id" = ?`, id);
  return rows[0] ? agentVersionRow(rows[0]) : null;
}

export async function patchAgentVersion(raw: RawSql, id: string, patch: AgentVersionPatch): Promise<AgentVersionRow> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.label !== undefined) {
    sets.push(`"label" = ?`);
    args.push(patch.label);
  }
  if (patch.iterationId !== undefined) {
    sets.push(`"iterationId" = ?`);
    args.push(patch.iterationId);
  }
  if (sets.length > 0) {
    const changed = await raw.execute(`UPDATE "AgentVersion" SET ${sets.join(", ")} WHERE "id" = ?`, ...args, id);
    if (changed === 0) throw new Error(`agent version ${id} not found`);
  }
  const row = await selectAgentVersion(raw, id);
  if (!row) throw new Error(`agent version ${id} not found`);
  return row;
}

export async function selectAgentVersions(raw: RawSql, companyId: string, filter: AgentVersionFilter): Promise<AgentVersionRow[]> {
  const clauses = [`"companyId" = ?`];
  const args: unknown[] = [companyId];
  if (filter.agentId !== undefined) {
    clauses.push(`"agentId" = ?`);
    args.push(filter.agentId);
  }
  if (filter.label !== undefined) {
    clauses.push(`"label" = ?`);
    args.push(filter.label);
  }
  const rows = await raw.query<Row>(`SELECT * FROM "AgentVersion" WHERE ${clauses.join(" AND ")} ORDER BY "version" DESC, "createdAt" DESC`, ...args);
  return rows.map(agentVersionRow);
}
