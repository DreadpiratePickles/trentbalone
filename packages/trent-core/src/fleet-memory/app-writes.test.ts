/**
 * [C1] The write side: a seat's episodic append also lands in the app's episodic tier, and the
 * consolidation's delta operations become semantic facts with the supersedes chain set.
 */
import { describe, expect, it } from "vitest";

import { record } from "../tools/action.js";
import type { MemoryAdapter } from "../tools/memory/index.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { AppDocument } from "./app-tiers.js";
import {
  seatEpisodeCycleId,
  semanticFactSource,
  withAppEpisodicMirror,
  writeConsolidatedFacts,
  writeSeatEpisode,
  type AppMemoryWriteModules,
} from "./app-writes.js";

interface Written {
  readonly cycleId: string;
  readonly summary: string;
  readonly roles: readonly string[];
}

function fakeModules(documents: AppDocument[] = []): AppMemoryWriteModules & {
  episodes: Written[];
  facts: Array<{ factType: string; content: string; source: string; supersedesId?: string }>;
  expired: string[];
} {
  const episodes: Written[] = [];
  const facts: Array<{ factType: string; content: string; source: string; supersedesId?: string }> = [];
  const expired: string[] = [];
  let next = 0;
  return {
    episodes,
    facts,
    expired,
    async writeEpisodicMemory(options) {
      episodes.push({ cycleId: options.cycleId, summary: options.summary, roles: options.agentResults.map((r) => r.role) });
    },
    createSemanticMemory() {
      const staged: typeof facts = [];
      return {
        add(fact) {
          staged.push(fact);
        },
        async flush() {
          facts.push(...staged);
          return staged.map(() => ({ id: `doc_new_${(next += 1)}` }));
        },
      };
    },
    async listDocuments() {
      return documents;
    },
    async expireDocument(id) {
      expired.push(id);
    },
  };
}

function factDoc(id: string, block: string, text: string): AppDocument {
  return {
    id,
    companyId: "co_1",
    type: "agent_note",
    title: `[semantic] ${block}`,
    content: text,
    source: semanticFactSource(block, text),
    version: 1,
    memoryTier: "semantic",
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("writeSeatEpisode", () => {
  it("writes one episodic row carrying the seat and the run id", async () => {
    const modules = fakeModules();
    const outcome = await writeSeatEpisode({
      companyId: "co_1",
      runId: "run_1",
      seat: "growth",
      text: "pricing test beat the control by 12 percent",
      modules,
    });
    expect(outcome).toEqual({ written: 1, expired: 0, skipped: 0, reason: null });
    expect(modules.episodes).toHaveLength(1);
    expect(modules.episodes[0]?.cycleId).toBe(seatEpisodeCycleId("run_1", "growth"));
    expect(modules.episodes[0]?.cycleId).toContain("run_1");
    expect(modules.episodes[0]?.roles).toEqual(["growth"]);
    expect(modules.episodes[0]?.summary).toContain("pricing test beat the control");
  });

  it("writes nothing and says why when the app store cannot serve a query", async () => {
    const outcome = await writeSeatEpisode({
      companyId: "co_1",
      runId: "run_1",
      seat: "growth",
      text: "a fact",
      modules: {
        ...fakeModules(),
        async writeEpisodicMemory() {
          throw new Error("Error validating datasource `db`: the URL must start with the protocol `postgresql://`");
        },
      },
    });
    expect(outcome.written).toBe(0);
    expect(outcome.reason).toContain("postgresql");
  });

  it("refuses an empty episode rather than writing a blank row", async () => {
    const modules = fakeModules();
    const outcome = await writeSeatEpisode({ companyId: "co_1", runId: "run_1", seat: "growth", text: "   ", modules });
    expect(outcome.written).toBe(0);
    expect(modules.episodes).toEqual([]);
  });
});

describe("writeConsolidatedFacts", () => {
  const entries = ["MRR is 1000", "churn is 4 percent", "ICP is seed-stage founders"];

  it("writes an appended entry as a semantic fact with nothing superseded", async () => {
    const modules = fakeModules();
    const outcome = await writeConsolidatedFacts({
      companyId: "co_1",
      block: "COMPANY.md",
      entries,
      ops: [{ op: "append", text: "pricing is usage-based" }],
      modules,
    });
    expect(outcome.written).toBe(1);
    expect(modules.facts[0]?.content).toBe("pricing is usage-based");
    expect(modules.facts[0]?.supersedesId).toBeUndefined();
    expect(modules.facts[0]?.source).toBe(semanticFactSource("COMPANY.md", "pricing is usage-based"));
  });

  it("sets supersedesId to the row the replaced entry wrote", async () => {
    const modules = fakeModules([factDoc("doc_old", "COMPANY.md", "MRR is 1000")]);
    const outcome = await writeConsolidatedFacts({
      companyId: "co_1",
      block: "COMPANY.md",
      entries,
      ops: [{ op: "replace", entry_id: "e1", text: "MRR is 2000" }],
      modules,
    });
    expect(outcome.written).toBe(1);
    expect(modules.facts[0]?.content).toBe("MRR is 2000");
    expect(modules.facts[0]?.supersedesId).toBe("doc_old");
  });

  it("expires the row a removed entry wrote and writes no new fact", async () => {
    const modules = fakeModules([factDoc("doc_churn", "COMPANY.md", "churn is 4 percent")]);
    const outcome = await writeConsolidatedFacts({
      companyId: "co_1",
      block: "COMPANY.md",
      entries,
      ops: [{ op: "remove", entry_id: "e2" }],
      modules,
    });
    expect(outcome).toEqual({ written: 0, expired: 1, skipped: 0, reason: null });
    expect(modules.expired).toEqual(["doc_churn"]);
    expect(modules.facts).toEqual([]);
  });

  it("merges to one fact that supersedes the first row and expires the rest", async () => {
    const modules = fakeModules([
      factDoc("doc_mrr", "COMPANY.md", "MRR is 1000"),
      factDoc("doc_churn", "COMPANY.md", "churn is 4 percent"),
    ]);
    const outcome = await writeConsolidatedFacts({
      companyId: "co_1",
      block: "COMPANY.md",
      entries,
      ops: [{ op: "merge", entry_ids: ["e1", "e2"], text: "MRR 1000 at 4 percent churn" }],
      modules,
    });
    expect(outcome.written).toBe(1);
    expect(modules.facts[0]?.supersedesId).toBe("doc_mrr");
    expect(modules.expired).toEqual(["doc_churn"]);
  });

  it("writes nothing at all when no operation was proposed", async () => {
    const modules = fakeModules();
    const outcome = await writeConsolidatedFacts({ companyId: "co_1", block: "COMPANY.md", entries, ops: [], modules });
    expect(outcome).toEqual({ written: 0, expired: 0, skipped: 0, reason: null });
  });
});

describe("withAppEpisodicMirror", () => {
  function adapterReturning(status: ToolCallRecord["status"]): MemoryAdapter {
    return {
      name: "memory",
      blocks: [],
      scopes: ["memory"],
      availability: "real",
      instructions: "",
      routingText: "",
      healthCheck: async () => "connected",
      estimateCost: () => 0,
      requiresApproval: () => false,
      cleanup: async () => {},
      frozenSnapshot: () => "",
      thaw: () => {},
      bindCallerContext: () => {},
      execute: async (action: string) => record("memory", action, status, "done"),
      dryRun: async (action: string) => record("memory", action, "mocked", "dry run"),
    } as unknown as MemoryAdapter;
  }

  it("mirrors a completed append into the app's episodic tier", async () => {
    const modules = fakeModules();
    const seen: string[] = [];
    const { adapter: mirrored } = withAppEpisodicMirror(adapterReturning("completed"), {
      modules,
      caller: () => ({ companyId: "co_1", runId: "run_1", seat: "growth" }),
      onFailure: (reason) => seen.push(reason),
    });
    const result = await mirrored.execute('memory {"action":"add","content":"the demo call converts at 30 percent"}', {});
    expect(result.status).toBe("completed");
    expect(modules.episodes).toHaveLength(1);
    expect(modules.episodes[0]?.summary).toContain("demo call converts");
    expect(seen).toEqual([]);
  });

  it("mirrors nothing when the seat's write was refused or blocked", async () => {
    const modules = fakeModules();
    const { adapter: mirrored } = withAppEpisodicMirror(adapterReturning("blocked"), {
      modules,
      caller: () => ({ companyId: "co_1", runId: "run_1", seat: "growth" }),
    });
    await mirrored.execute('memory {"action":"add","content":"a fact"}', {});
    expect(modules.episodes).toEqual([]);
  });

  it("mirrors nothing for a read, and never mirrors a replace", async () => {
    const modules = fakeModules();
    const { adapter: mirrored } = withAppEpisodicMirror(adapterReturning("completed"), {
      modules,
      caller: () => ({ companyId: "co_1", runId: "run_1", seat: "growth" }),
    });
    await mirrored.execute('memory {"action":"replace","old_text":"a","content":"b"}', {});
    await mirrored.execute("memory", {});
    expect(modules.episodes).toEqual([]);
  });

  it("never changes what the seat is told, even when the mirror fails", async () => {
    const failures: string[] = [];
    const { adapter: mirrored } = withAppEpisodicMirror(adapterReturning("completed"), {
      modules: {
        ...fakeModules(),
        async writeEpisodicMemory() {
          throw new Error("store unreachable");
        },
      },
      caller: () => ({ companyId: "co_1", runId: "run_1", seat: "growth" }),
      onFailure: (reason) => failures.push(reason),
    });
    const result = await mirrored.execute('memory {"action":"add","content":"a fact worth keeping"}', {});
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
    expect(failures[0]).toContain("store unreachable");
  });
});

describe("against the app's real memory-tiers module", () => {
  // No DATABASE_URL under vitest, so `apps/web/lib/store.ts` selects the in-process memStore and
  // the real `writeEpisodicMemory` / `SemanticMemory` run end to end. Durability is Bun's problem
  // (`app-memory.bun.test.ts`); correctness of the call is provable here.
  it("writes a real episodic row and a real superseding fact", async () => {
    const { loadAppWriteModules } = await import("./app-writes.js");
    const { createAppMemoryReader, loadAppMemoryModules } = await import("./app-tiers.js");
    const modules = await loadAppWriteModules();
    const { store } = (await import("@/lib/store")) as unknown as {
      store: { createCompany(input: { name: string; slug: string; budgetCents: number }): Promise<{ id: string }> };
    };
    const company = await store.createCompany({ name: "C1 Co", slug: `c1-${Date.now()}`, budgetCents: 100 });

    const episode = await writeSeatEpisode({
      companyId: company.id,
      runId: "run_real_1",
      seat: "growth",
      text: "the onboarding email doubled activation",
      modules,
    });
    expect(episode).toEqual({ written: 1, expired: 0, skipped: 0, reason: null });

    await writeConsolidatedFacts({
      companyId: company.id,
      block: "COMPANY.md",
      entries: [],
      ops: [{ op: "append", text: "activation is 40 percent" }],
      modules,
    });
    const read = createAppMemoryReader({ modules: loadAppMemoryModules });
    const before = await read(company.id, "growth");
    expect(before.map((e) => e.text).join(" ")).toContain("activation is 40 percent");

    await writeConsolidatedFacts({
      companyId: company.id,
      block: "COMPANY.md",
      entries: ["activation is 40 percent"],
      ops: [{ op: "replace", entry_id: "e1", text: "activation is 55 percent" }],
      modules,
    });
    const after = (await read(company.id, "growth")).map((e) => e.text).join(" ");
    expect(after).toContain("activation is 55 percent");
    expect(after).not.toContain("activation is 40 percent");
    expect(after).toContain("onboarding email doubled activation");
  });
});
