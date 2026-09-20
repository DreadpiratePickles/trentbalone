/**
 * [C1] The read side of the app's tiered company memory.
 *
 * The app modules these entries come from are the REAL ones — `active-documents.ts`,
 * `capability-memory.ts` and `trench-wiki.ts` are pure and open no store — so this suite proves
 * the wrapper reads through the app's own functions rather than reimplementing their rules.
 * Only `listDocuments` and `buildSeatRegistryRecall`, the two that touch the store singleton, are
 * handed in as fakes.
 */
import { describe, expect, it, vi } from "vitest";

import { filterActiveDocuments } from "@/lib/active-documents";
import { summarizeCapability } from "@/lib/capability-memory";
import { buildWikiPageSummary, buildWikiSources } from "@/lib/trench-wiki";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import {
  APP_MEMORY_SOURCES,
  DEFAULT_APP_MEMORY_BUDGETS,
  activeAppDocuments,
  buildAppMemoryEntries,
  classifyAppDocument,
  createAppMemoryReader,
  type AppDocument,
  type AppMemoryModules,
} from "./app-tiers.js";

const AT = "2026-09-18T12:00:00.000Z";

function doc(partial: Partial<AppDocument> & { id: string }): AppDocument {
  return {
    companyId: "co_1",
    type: "agent_note",
    title: partial.id,
    content: `content of ${partial.id}`,
    source: "seed",
    version: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...partial,
  };
}

function modules(documents: readonly AppDocument[], registryRecall = ""): AppMemoryModules {
  return {
    listDocuments: async () => documents,
    filterActiveDocuments,
    summarizeCapability,
    buildSeatRegistryRecall: async () => registryRecall,
    buildWikiSources,
    buildWikiPageSummary,
  };
}

describe("classifyAppDocument", () => {
  it("routes each app surface to its own source tag", () => {
    expect(classifyAppDocument(doc({ id: "d1", source: "wiki:/notes/pricing.md" }))).toBe("wiki");
    expect(classifyAppDocument(doc({ id: "d2", source: "capability_memory", memoryTier: "semantic" }))).toBe("capabilities");
    expect(classifyAppDocument(doc({ id: "d3", source: "seat-registry:growth:run_1:step_1", memoryTier: "semantic" }))).toBe("registries");
    expect(classifyAppDocument(doc({ id: "d4", source: "ceo-decision-journal:run_1", memoryTier: "semantic" }))).toBe("decisions");
    expect(classifyAppDocument(doc({ id: "d5", source: "cycle:c1", memoryTier: "episodic" }))).toBe("tiers");
    expect(classifyAppDocument(doc({ id: "d6", type: "brief", source: "founder" }))).toBe("documents");
  });

  it("drops the wiki index snapshot, which is a generated index and not a note", () => {
    expect(classifyAppDocument(doc({ id: "d7", source: "trench_wiki_indexer" }))).toBeNull();
  });
});

describe("the run an app-memory row belongs to", () => {
  it("[G2] carries the run id of an episodic row, so a stopped run's episodes can be left out", () => {
    const entries = buildAppMemoryEntries({
      companyId: "co_1",
      seat: "growth",
      documents: [
        doc({ id: "d1", source: "cycle:run_1:growth", memoryTier: "episodic", content: "the migration plan starts with the index" }),
        doc({ id: "d2", source: "cycle:orc_run_2", memoryTier: "episodic", content: "the run 2 episode quotes every step" }),
        doc({ id: "d3", source: "founder-brief", memoryTier: "working", content: "the founder wants the backfill done" }),
      ],
      registryRecall: "",
      modules: modules([]),
      budgets: DEFAULT_APP_MEMORY_BUDGETS,
      atIso: AT,
    });
    expect(entries.find((entry) => entry.id === "d1")?.runId).toBe("run_1");
    expect(entries.find((entry) => entry.id === "d2")?.runId).toBe("orc_run_2");
    expect(entries.find((entry) => entry.id === "d3")?.runId).toBeNull();
  });
});

describe("activeAppDocuments", () => {
  it("honours the validity window through the app's own filter", () => {
    const expired = doc({ id: "old", validFrom: "2026-09-01T00:00:00.000Z", validTo: "2026-09-10T00:00:00.000Z" });
    const future = doc({ id: "later", validFrom: "2026-12-01T00:00:00.000Z" });
    const live = doc({ id: "live", validFrom: "2026-09-02T00:00:00.000Z" });
    const kept = activeAppDocuments([expired, future, live], filterActiveDocuments, AT);
    expect(kept.map((d) => d.id)).toEqual(["live"]);
  });

  it("drops a fact another document supersedes even when nothing set its validTo", () => {
    // SemanticMemory.flush swallows a failed expireDocument, so validTo alone is not proof.
    const superseded = doc({ id: "fact_v1", memoryTier: "semantic", content: "MRR is 1000" });
    const current = doc({ id: "fact_v2", memoryTier: "semantic", content: "MRR is 2000", supersedesId: "fact_v1" });
    const kept = activeAppDocuments([superseded, current], filterActiveDocuments, AT);
    expect(kept.map((d) => d.id)).toEqual(["fact_v2"]);
  });
});

describe("buildAppMemoryEntries", () => {
  const documents = [
    doc({ id: "ep_1", memoryTier: "episodic", source: "cycle:c1", title: "Cycle c1", content: "growth shipped the pricing test" }),
    doc({ id: "sem_1", memoryTier: "semantic", source: "cycle:c1", title: "[semantic] mrr", content: "MRR is 2000" }),
    doc({ id: "brief_1", type: "brief", source: "founder", title: "Operating brief", content: "sell to seed-stage founders" }),
    doc({
      id: "cap_1",
      source: "capability_memory",
      memoryTier: "semantic",
      title: "Capability memory: growth pricing",
      content: JSON.stringify({
        companyId: "co_1",
        subjectId: "growth",
        taskType: "pricing",
        evalScore: 0.8,
        costCents: 12,
        latencyMs: 900,
        outcome: "success",
        privacyScope: "tenant",
      }),
    }),
    doc({
      id: "cap_2",
      source: "capability_memory",
      memoryTier: "semantic",
      title: "Capability memory: sales outbound",
      content: JSON.stringify({
        companyId: "co_1",
        subjectId: "sales",
        taskType: "outbound",
        evalScore: 0.2,
        costCents: 40,
        latencyMs: 2000,
        outcome: "failure",
        privacyScope: "tenant",
      }),
    }),
    doc({ id: "dec_1", source: "ceo-decision-journal:run_7", memoryTier: "semantic", title: "CEO decision journal: pick a wedge", content: "we chose the wedge" }),
    doc({ id: "wiki_1", source: "wiki:/notes/pricing.md", title: "Pricing note", content: "price on value, not seats" }),
  ];

  function entries(seat = "growth", budgets = DEFAULT_APP_MEMORY_BUDGETS) {
    return buildAppMemoryEntries({
      companyId: "co_1",
      seat,
      documents,
      registryRecall: "EXPERIMENT REGISTRY (recalled — registry key: experiments)\n- [doc_x] Experiment registry: pricing",
      modules: modules(documents),
      budgets,
      atIso: AT,
    });
  }

  it("tags every entry with the app surface it came from", () => {
    const seen = new Set(entries().map((entry) => entry.source));
    expect([...seen].sort()).toEqual([...APP_MEMORY_SOURCES].sort());
  });

  it("carries the tier rows, the plain documents, the decisions and the wiki note", () => {
    const byId = new Map(entries().map((entry) => [entry.id, entry]));
    expect(byId.get("ep_1")?.source).toBe("tiers");
    expect(byId.get("sem_1")?.text).toContain("MRR is 2000");
    expect(byId.get("brief_1")?.source).toBe("documents");
    expect(byId.get("dec_1")?.source).toBe("decisions");
    expect(byId.get("dec_1")?.runId).toBe("run_7");
    expect([...byId.values()].find((e) => e.source === "wiki")?.text).toContain("price on value");
  });

  it("summarises capability outcomes for the calling seat only", () => {
    const growth = entries("growth").filter((entry) => entry.source === "capabilities");
    expect(growth).toHaveLength(1);
    expect(growth[0]?.label).toContain("pricing");
    expect(growth[0]?.text).toContain("0.8");
    const sales = entries("sales").filter((entry) => entry.source === "capabilities");
    expect(sales[0]?.label).toContain("outbound");
  });

  it("recalls this seat's registry through the app's own recall builder", () => {
    const registry = entries().filter((entry) => entry.source === "registries");
    expect(registry).toHaveLength(1);
    expect(registry[0]?.text).toContain("Experiment registry: pricing");
  });

  it("holds every source inside its own character budget", () => {
    const tight = { ...DEFAULT_APP_MEMORY_BUDGETS, tiers: 20 };
    const used = entries("growth", tight)
      .filter((entry) => entry.source === "tiers")
      .reduce((sum, entry) => sum + entry.text.length, 0);
    expect(used).toBeLessThanOrEqual(20);
    expect(used).toBeGreaterThan(0);
  });

  it("drops a source entirely when its budget is zero", () => {
    const off = { ...DEFAULT_APP_MEMORY_BUDGETS, wiki: 0 };
    expect(entries("growth", off).some((entry) => entry.source === "wiki")).toBe(false);
  });
});

describe("createAppMemoryReader", () => {
  it("returns the entries for the company and seat", async () => {
    const documents = [doc({ id: "sem_1", memoryTier: "semantic", content: "churn is 2 percent" })];
    const read = createAppMemoryReader({ modules: async () => modules(documents), atIso: () => AT });
    const entries = await read("co_1", "growth");
    expect(entries.map((entry) => entry.id)).toEqual(["sem_1"]);
  });

  it("answers with nothing, and never throws, when the app store cannot serve a query", async () => {
    // A configured database that does not answer: recall must survive that.
    const read = createAppMemoryReader({
      modules: async () => ({
        ...modules([]),
        listDocuments: async () => {
          throw new Error("Can't reach database server at `db.internal:5432`");
        },
      }),
    });
    await expect(read("co_1", "growth")).resolves.toEqual([]);
  });

  it("answers with nothing up front, loading no app module, when the app store is not usable", async () => {
    // The one predicate (`app-store.ts`): unset, empty and a `file:` URL — the wrapper's own SQLite
    // store, never the app's — all mean the app tiers are skipped before any `import("@/lib/*")`.
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("@/lib/store", () => {
      loaded.push("@/lib/store");
      return { store: { listDocuments: async () => [] } };
    });
    try {
      const { createAppMemoryReader: fresh } = await import("./app-tiers.js");
      for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "file:/tmp/profile/trent.db" }]) {
        await expect(fresh({ env })("co_1", "growth")).resolves.toEqual([]);
      }
      expect(loaded).toEqual([]);
    } finally {
      vi.doUnmock("@/lib/store");
    }
  });
});

describe("loadAppMemoryModules", () => {
  it("refuses, naming the reason, before importing anything when the app store is not usable", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("@/lib/store", () => {
      loaded.push("@/lib/store");
      return { store: { listDocuments: async () => [] } };
    });
    try {
      const { loadAppMemoryModules } = await import("./app-tiers.js");
      const { AppStoreUnusedError } = await import("./app-store.js");
      await expect(loadAppMemoryModules({ DATABASE_URL: "file:/tmp/profile/trent.db" })).rejects.toBeInstanceOf(AppStoreUnusedError);
      await expect(loadAppMemoryModules({})).rejects.toThrow(/in-process/);
      expect(loaded).toEqual([]);
      // A postgres URL is the app's own datasource: the modules load, the store among them.
      const real = await loadAppMemoryModules({ DATABASE_URL: "postgresql://localhost/trent" });
      expect(typeof real.listDocuments).toBe("function");
      expect(loaded).toEqual(["@/lib/store"]);
    } finally {
      vi.doUnmock("@/lib/store");
    }
  });
});

describe("the shipped budgets", () => {
  it("are the config defaults, so a profile that names nothing gets exactly these", () => {
    expect(DEFAULT_CONFIG.memory.app_sources).toEqual(DEFAULT_APP_MEMORY_BUDGETS);
  });
});
