/**
 * [C1] The app-backed source now carries the company's own tiered memory as well as its runs,
 * and a seat's recall can show which surface each line came from.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_FLEET_MEMORY_CONFIG } from "./config.js";
import { createAppFleetSource } from "./app-source.js";
import { recallForObjective } from "./recall.js";
import { InMemoryFleetSource, freezeFleetSource, type FleetMemoryEntry, type FleetMemorySource } from "./source.js";

function entry(partial: Partial<FleetMemoryEntry> & { id: string }): FleetMemoryEntry {
  return { source: "tiers", label: partial.id, text: `text for ${partial.id}`, runId: null, ...partial };
}

describe("createAppFleetSource", () => {
  it("serves the app's company memory for the asking seat", async () => {
    const asked: Array<[string, string]> = [];
    const source = createAppFleetSource({
      appMemory: async (companyId, seat) => {
        asked.push([companyId, seat]);
        return [entry({ id: "sem_1", source: "tiers", text: "churn is 2 percent" })];
      },
    });
    const entries = await source.listAppMemory?.("co_1", "growth");
    expect(entries?.map((e) => e.id)).toEqual(["sem_1"]);
    expect(asked).toEqual([["co_1", "growth"]]);
  });

  it("builds a real reader when none is injected, and that reader never throws", async () => {
    const source = createAppFleetSource();
    await expect(source.listAppMemory?.("co_does_not_exist", "growth")).resolves.toBeInstanceOf(Array);
  });
});

describe("recall over the app's company memory", () => {
  function sourceWith(entries: readonly FleetMemoryEntry[]): FleetMemorySource {
    const base = new InMemoryFleetSource();
    return { ...base, listRuns: base.listRuns.bind(base), listAppMemory: async () => entries };
  }

  it("ranks the app entries alongside the run-derived ones and names their surface", async () => {
    const result = await recallForObjective(
      sourceWith([
        entry({ id: "sem_1", source: "tiers", label: "semantic | mrr", text: "MRR is 2000 dollars this month" }),
        entry({ id: "dec_1", source: "decisions", label: "CEO decision journal: the wedge", text: "we chose the seed-stage wedge" }),
      ]),
      { companyId: "co_1", seat: "growth", objective: "report this month's MRR" },
    );
    expect(result.items.map((item) => item.kind)).toContain("app");
    const mrr = result.items.find((item) => item.label.includes("mrr"));
    expect(mrr?.agentId).toBe("tiers");
    expect(result.block).toContain("tiers | semantic | mrr");
    expect(result.chars).toBeLessThanOrEqual(DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars);
  });

  it("never changes the score of a candidate that was already reaching the seat", async () => {
    // The app's own memory-log and decision-journal rows restate a run in the app's words, so
    // folding them into one TF-IDF corpus re-weighted the run's terms and evicted the step output
    // the seat had been recalling. Each population is scored in its own corpus for that reason.
    const base = new InMemoryFleetSource();
    base.addRun({
      id: "run_1",
      companyId: "co_1",
      objective: "integrate the partner API client with rate limiting",
      status: "completed",
      summary: null,
      completedAt: "2026-09-17T00:00:00.000Z",
      steps: [
        {
          id: "step_1",
          runId: "run_1",
          agentRole: "engineer",
          title: "Integrate the partner API",
          status: "completed",
          output: "Integrated the partner API client with a token bucket at 60 requests per minute.",
        },
      ],
    });
    const objective = { companyId: "co_1", seat: "support", objective: "integrate the partner API client with rate limiting" };
    const alone = await recallForObjective({ listRuns: base.listRuns.bind(base) }, objective);
    const withApp = await recallForObjective(
      {
        listRuns: base.listRuns.bind(base),
        listAppMemory: async () => [
          entry({ id: "log_1", source: "tiers", label: "episodic | Memory log", text: "integrate the partner API client with rate limiting" }),
          entry({ id: "dec_1", source: "decisions", label: "CEO decision journal", text: "integrate the partner API client with rate limiting" }),
        ],
      },
      objective,
    );
    const scoreOf = (result: Awaited<ReturnType<typeof recallForObjective>>) =>
      result.items.find((item) => item.agentId === "engineer")?.score;
    expect(scoreOf(alone)).toBeDefined();
    expect(scoreOf(withApp)).toBe(scoreOf(alone));
  });

  it("recalls nothing extra from a source that has no app memory at all", async () => {
    const result = await recallForObjective(new InMemoryFleetSource(), {
      companyId: "co_1",
      seat: "growth",
      objective: "report this month's MRR",
    });
    expect(result.items).toEqual([]);
  });
});

describe("freezeFleetSource", () => {
  it("freezes the app memory per seat, not per company", async () => {
    const calls: string[] = [];
    const base = new InMemoryFleetSource();
    const frozen = freezeFleetSource({
      listRuns: base.listRuns.bind(base),
      listAppMemory: async (companyId, seat) => {
        calls.push(seat);
        return [entry({ id: `${companyId}:${seat}` })];
      },
    });
    await frozen.listAppMemory?.("co_1", "growth");
    await frozen.listAppMemory?.("co_1", "growth");
    await frozen.listAppMemory?.("co_1", "sales");
    expect(calls).toEqual(["growth", "sales"]);
  });

  it("passes a source with no app memory through unchanged", () => {
    const frozen = freezeFleetSource(new InMemoryFleetSource());
    expect(frozen.listAppMemory).toBeUndefined();
  });
});
