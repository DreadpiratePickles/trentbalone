/**
 * [C1] The app's tiered company memory, read as recall candidates.
 *
 * Until this module the fleet's shared context was step outputs, run summaries, skills and the
 * playbook — everything the ORCHESTRATOR produced — while the company's actual memory sat in
 * `Document` rows the web app has written for far longer: the three tiers of `memory-tiers.ts`,
 * the founder's briefs, capability outcomes, per-seat registries, the CEO decision journal and
 * the wiki notes. A seat could not see any of it.
 *
 * Truth rule (roadmap Phase C): `Document` rows with validity windows are the truth for FACTS;
 * `brain/` is the truth for identity, decisions and episodic notes. So the facts are read here
 * and nothing here writes a brain file.
 *
 * Invariant 1 holds on this side exactly as it does in `app-source.ts`: every rule belongs to an
 * `apps/web` function and is called, never restated. `filterActiveDocuments` decides what is
 * valid now, `summarizeCapability` decides what a capability record means, `buildSeatRegistryRecall`
 * renders a seat's registry and `buildWikiSources` / `buildWikiPageSummary` decide what a wiki note
 * is (including the path blocklist that keeps `.env` and keys out of a prompt). The two functions
 * that touch the store singleton are the only ones this module injects, so the whole partition and
 * budget can be proved without a database.
 *
 * ONE thing is decided here and not by the app: a document another document supersedes is dropped
 * even when its `validTo` is unset. `SemanticMemory.flush` expires the old row through
 * `expireDocument(...).catch(() => {})` (`apps/web/lib/memory-tiers.ts:205`), so a failed expiry is
 * silent and the superseded fact stays "active". Recalling a fact that has been replaced is the
 * one failure this tier exists to prevent, so the chain is followed as well as the window.
 *
 * Every source carries its own character budget (config `memory.app_sources`). The budget is on
 * the candidate TEXT, before ranking: it bounds what the ranker has to score and what the recall
 * block can grow to, so this tier cannot push the assembled injection past `context.ceiling_chars`.
 */

import type { FleetMemoryEntry } from "./source.js";

/** The six app surfaces, in the order they are collected and budgeted. */
export const APP_MEMORY_SOURCES = ["tiers", "documents", "capabilities", "registries", "decisions", "wiki"] as const;
export type AppMemorySourceName = (typeof APP_MEMORY_SOURCES)[number];

export type AppMemoryBudgets = Readonly<Record<AppMemorySourceName, number>>;

/**
 * Characters of candidate text per source. The sum (14,000) is under a quarter of the shipped
 * `context.ceiling_chars` (60,000), so the whole app tier cannot crowd out the memory blocks, the
 * skills index or the transcript even before the ranker cuts it to `recallBudgetChars`.
 * The two document surfaces get the larger share because they carry the facts; the four derived
 * surfaces are summaries and one is a rendered block already bounded by the app.
 */
export const DEFAULT_APP_MEMORY_BUDGETS: AppMemoryBudgets = {
  tiers: 4_000,
  documents: 4_000,
  capabilities: 1_500,
  registries: 1_500,
  decisions: 1_500,
  wiki: 1_500,
};

/** The nine document types and the three tiers, exactly as `apps/web/lib/types.ts` declares them. */
export type AppDocumentType =
  | "brief"
  | "roadmap"
  | "marketing_plan"
  | "research"
  | "support_summary"
  | "weekly_report"
  | "agent_note"
  | "feature_gap"
  | "email_draft";
export type AppMemoryTier = "working" | "episodic" | "semantic";

/**
 * The `Document` row as this module reads it. Structural, like every type in `app-source.ts`, so
 * the `apps/web` type graph is not dragged into this package's build — but narrowed to the app's
 * own unions where they exist, because `buildWikiSources` takes real `Document`s and a widened
 * `type` would not be assignable to it.
 */
export interface AppDocument {
  readonly id: string;
  readonly companyId: string;
  readonly type: AppDocumentType;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly version: number;
  readonly memoryTier?: AppMemoryTier;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesId?: string;
  readonly createdAt: string;
}

interface AppCapabilityRecord {
  readonly companyId: string;
  readonly subjectId: string;
  readonly taskType: string;
  readonly evalScore: number;
  readonly costCents: number;
  readonly latencyMs: number;
  readonly outcome: "success" | "failure";
}

interface AppCapabilitySummaryRow {
  readonly subjectId: string;
  readonly taskType: string;
  readonly averageScore: number;
  readonly successRate: number;
  readonly averageCostCents: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
}

interface AppWikiSource {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly path: string;
  readonly content: string;
  readonly createdAt: string;
}

interface AppWikiPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
}

type ActiveFilter = <T extends { validFrom?: string; validTo?: string }>(documents: T[], atIso?: string) => T[];

/** The read-only `apps/web` functions this module leans on, as it calls them. */
export interface AppMemoryModules {
  listDocuments(companyId: string): Promise<readonly AppDocument[]>;
  filterActiveDocuments: ActiveFilter;
  summarizeCapability(records: AppCapabilityRecord[]): Record<string, AppCapabilitySummaryRow>;
  buildSeatRegistryRecall(companyId: string, role: string, limit?: number): Promise<string>;
  buildWikiSources(input: {
    sessions: never[];
    events: never[];
    artifacts: never[];
    documents: AppDocument[];
  }): AppWikiSource[];
  buildWikiPageSummary(source: AppWikiSource): AppWikiPage;
}

const CAPABILITY_SOURCE = "capability_memory";
const REGISTRY_PREFIX = "seat-registry:";
const DECISION_PREFIX = "ceo-decision-journal:";
const WIKI_PREFIX = "wiki:";
/** `trench-wiki.ts` excludes its own generated index from the sources; so does this. */
const WIKI_INDEX_SOURCE = "trench_wiki_indexer";

/**
 * Which app surface a document belongs to, or `null` when it is not company memory at all.
 * The tagged sources are checked before the tier, because a capability record, a registry entry
 * and a decision are all written as `memoryTier: "semantic"` and would otherwise be one blur.
 */
export function classifyAppDocument(document: AppDocument): AppMemorySourceName | null {
  const source = document.source ?? "";
  if (source === WIKI_INDEX_SOURCE) return null;
  if (source.startsWith(WIKI_PREFIX)) return "wiki";
  if (source === CAPABILITY_SOURCE) return "capabilities";
  if (source.startsWith(REGISTRY_PREFIX)) return "registries";
  if (source.startsWith(DECISION_PREFIX)) return "decisions";
  if (document.memoryTier !== undefined) return "tiers";
  return "documents";
}

/**
 * The documents that are true right now: inside their validity window (the app's own filter) and
 * not replaced by a later one. See the header for why the chain is followed as well as the window.
 */
export function activeAppDocuments(
  documents: readonly AppDocument[],
  filterActive: ActiveFilter,
  atIso?: string,
): AppDocument[] {
  const superseded = new Set<string>();
  for (const document of documents) {
    if (document.supersedesId !== undefined && document.supersedesId !== "") superseded.add(document.supersedesId);
  }
  return filterActive([...documents], atIso).filter((document) => !superseded.has(document.id));
}

function newestFirst(a: AppDocument, b: AppDocument): number {
  const left = b.validFrom ?? b.createdAt ?? "";
  const right = a.validFrom ?? a.createdAt ?? "";
  return left.localeCompare(right);
}

/** `seat-registry:<seat>:<runId>:<stepId>` and `ceo-decision-journal:<runId>` carry a run id. */
function runIdFrom(source: string, prefix: string): string | null {
  if (!source.startsWith(prefix)) return null;
  const rest = source.slice(prefix.length).split(":");
  const candidate = prefix === REGISTRY_PREFIX ? rest[1] : rest[0];
  return candidate === undefined || candidate === "" ? null : candidate;
}

function parseCapabilityRecord(document: AppDocument): AppCapabilityRecord | null {
  try {
    const parsed = JSON.parse(document.content) as Partial<AppCapabilityRecord>;
    if (typeof parsed.subjectId !== "string" || typeof parsed.taskType !== "string") return null;
    return {
      companyId: typeof parsed.companyId === "string" ? parsed.companyId : document.companyId,
      subjectId: parsed.subjectId,
      taskType: parsed.taskType,
      evalScore: typeof parsed.evalScore === "number" ? parsed.evalScore : 0,
      costCents: typeof parsed.costCents === "number" ? parsed.costCents : 0,
      latencyMs: typeof parsed.latencyMs === "number" ? parsed.latencyMs : 0,
      outcome: parsed.outcome === "failure" ? "failure" : "success",
    };
  } catch {
    return null;
  }
}

function capabilityText(row: AppCapabilitySummaryRow): string {
  return [
    `score ${row.averageScore}`,
    `success rate ${row.successRate}`,
    `cost ${row.averageCostCents} cents`,
    `latency ${row.averageLatencyMs} ms`,
    `over ${row.sampleCount} run(s)`,
  ].join(", ");
}

export interface BuildAppMemoryInput {
  readonly companyId: string;
  readonly seat: string;
  readonly documents: readonly AppDocument[];
  /** `buildSeatRegistryRecall` for this seat, already awaited; "" when the seat owns no registry. */
  readonly registryRecall: string;
  readonly modules: AppMemoryModules;
  readonly budgets: AppMemoryBudgets;
  readonly atIso?: string;
}

/**
 * The candidates one seat may recall from the app's company memory, each tagged with its source
 * and each source held inside its own character budget. Newest first within a source, because the
 * budget is spent from the front and the newest fact is the one a stale one was replaced by.
 */
export function buildAppMemoryEntries(input: BuildAppMemoryInput): FleetMemoryEntry[] {
  const active = activeAppDocuments(input.documents, input.modules.filterActiveDocuments, input.atIso);
  const buckets = new Map<AppMemorySourceName, AppDocument[]>();
  for (const document of active) {
    const name = classifyAppDocument(document);
    if (name === null) continue;
    buckets.set(name, [...(buckets.get(name) ?? []), document]);
  }
  for (const list of buckets.values()) list.sort(newestFirst);

  const entries: FleetMemoryEntry[] = [];
  const spend = new Budget(input.budgets);

  for (const document of buckets.get("tiers") ?? []) {
    spend.push(entries, "tiers", {
      id: document.id,
      label: `${document.memoryTier ?? "memory"} | ${document.title}`,
      text: document.content,
      runId: null,
    });
  }
  for (const document of buckets.get("documents") ?? []) {
    spend.push(entries, "documents", {
      id: document.id,
      label: `${document.type} | ${document.title}`,
      text: document.content,
      runId: null,
    });
  }

  // Capability outcomes are the seat's own track record, so only this seat's rows are summarised.
  const records = (buckets.get("capabilities") ?? [])
    .map(parseCapabilityRecord)
    .filter((record): record is AppCapabilityRecord => record !== null && record.subjectId === input.seat);
  if (records.length > 0) {
    const summary = input.modules.summarizeCapability(records);
    for (const [key, row] of Object.entries(summary)) {
      spend.push(entries, "capabilities", {
        id: `capability:${key}`,
        label: `${row.subjectId} ${row.taskType}`,
        text: capabilityText(row),
        runId: null,
      });
    }
  }

  if (input.registryRecall.trim() !== "") {
    spend.push(entries, "registries", {
      id: `registry:${input.seat}`,
      label: `${input.seat} registry`,
      text: input.registryRecall,
      runId: null,
    });
  }

  for (const document of buckets.get("decisions") ?? []) {
    spend.push(entries, "decisions", {
      id: document.id,
      label: document.title,
      text: document.content,
      runId: runIdFrom(document.source, DECISION_PREFIX),
    });
  }

  const wikiDocuments = buckets.get("wiki") ?? [];
  if (wikiDocuments.length > 0) {
    const sources = input.modules.buildWikiSources({ sessions: [], events: [], artifacts: [], documents: wikiDocuments });
    for (const source of sources) {
      const page = input.modules.buildWikiPageSummary(source);
      spend.push(entries, "wiki", { id: source.id, label: page.title, text: page.summary, runId: null });
    }
  }

  return entries;
}

/** Spends each source's character budget from the front, clipping the entry that reaches the end. */
class Budget {
  readonly #left: Record<string, number>;

  constructor(budgets: AppMemoryBudgets) {
    this.#left = Object.fromEntries(APP_MEMORY_SOURCES.map((name) => [name, Math.max(0, Math.trunc(budgets[name]))]));
  }

  push(into: FleetMemoryEntry[], source: AppMemorySourceName, entry: Omit<FleetMemoryEntry, "source">): void {
    const left = this.#left[source] ?? 0;
    if (left <= 0) return;
    const text = entry.text.trim();
    if (text === "") return;
    const kept = text.length <= left ? text : text.slice(0, left);
    this.#left[source] = left - kept.length;
    into.push({ ...entry, source, text: kept });
  }
}

export type AppMemoryReader = (companyId: string, seat: string) => Promise<readonly FleetMemoryEntry[]>;

export interface AppMemoryReaderOptions {
  readonly budgets?: AppMemoryBudgets;
  /** The app modules; the real lazy imports when omitted. Memoised by the reader, loaded once. */
  readonly modules?: () => Promise<AppMemoryModules>;
  readonly atIso?: () => string;
}

/**
 * The real `apps/web` modules, imported lazily and only when a seat actually recalls — the same
 * rule `app-source.ts` follows, so nothing here is evaluated before `applyStandaloneEnv` has run.
 */
export async function loadAppMemoryModules(): Promise<AppMemoryModules> {
  const [store, documents, capability, registries, wiki] = await Promise.all([
    import("@/lib/store") as unknown as Promise<{ store: { listDocuments(companyId: string): Promise<AppDocument[]> } }>,
    import("@/lib/active-documents") as unknown as Promise<{ filterActiveDocuments: ActiveFilter }>,
    import("@/lib/capability-memory") as unknown as Promise<Pick<AppMemoryModules, "summarizeCapability">>,
    import("@/lib/seat-memory-registries") as unknown as Promise<Pick<AppMemoryModules, "buildSeatRegistryRecall">>,
    import("@/lib/trench-wiki") as unknown as Promise<Pick<AppMemoryModules, "buildWikiSources" | "buildWikiPageSummary">>,
  ]);
  return {
    listDocuments: (companyId) => store.store.listDocuments(companyId),
    filterActiveDocuments: documents.filterActiveDocuments,
    summarizeCapability: capability.summarizeCapability,
    buildSeatRegistryRecall: registries.buildSeatRegistryRecall,
    buildWikiSources: wiki.buildWikiSources,
    buildWikiPageSummary: wiki.buildWikiPageSummary,
  };
}

/**
 * One seat's view of the app's company memory.
 *
 * Every failure resolves empty. The app store singleton is Prisma whenever `DATABASE_URL` is set
 * (`apps/web/lib/store.ts:11`) against a POSTGRESQL client, so the standalone durable profile —
 * which points that variable at `<profile>/trent.db` — makes every app store call throw. Fleet
 * recall must degrade to the run-derived candidates there, never fail the seat.
 */
export function createAppMemoryReader(options: AppMemoryReaderOptions = {}): AppMemoryReader {
  const budgets = options.budgets ?? DEFAULT_APP_MEMORY_BUDGETS;
  const load = options.modules ?? loadAppMemoryModules;
  let modules: Promise<AppMemoryModules> | undefined;
  return async (companyId, seat) => {
    try {
      modules ??= load();
      const app = await modules;
      const [documents, registryRecall] = await Promise.all([
        app.listDocuments(companyId),
        app.buildSeatRegistryRecall(companyId, seat).catch(() => ""),
      ]);
      return buildAppMemoryEntries({
        companyId,
        seat,
        documents,
        registryRecall,
        modules: app,
        budgets,
        ...(options.atIso === undefined ? {} : { atIso: options.atIso() }),
      });
    } catch {
      modules = undefined;
      return [];
    }
  };
}
