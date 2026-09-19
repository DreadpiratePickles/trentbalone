/**
 * [D5] item 2 — a tool over its health threshold becomes a DRAFT, through the same gates as any
 * other draft: frozen surface, content-hash veto, and a human promotion at the end.
 */
import { describe, expect, it } from "vitest";

import type { AgentTraceRow, ImproveStorePort } from "../store/StorePort.js";
import { InMemoryImproveStore } from "./memory-store.js";
import type { DraftGateContext } from "./draft-gates.js";
import { encodeToolCall } from "./tool-health.js";
import { TOOL_DRAFT_AGENT, decodeToolDraft, offlineToolProposal, proposeToolDrafts, toolProposalPrompt } from "./tool-drafts.js";
import { vetoedHashes } from "./veto.js";
import { rejectDraft } from "./lifecycle.js";
import { runImprovementSweep } from "./sweep.js";

const COMPANY = "co_tool_drafts";
const NOW = "2026-09-18T12:00:00.000Z";

function row(id: string, calls: string[]): AgentTraceRow {
  return {
    id,
    companyId: COMPANY,
    agentRole: "engineer",
    agentId: "engineer",
    runId: "run_1",
    taskType: "ship-feature",
    stepTitle: "implement",
    status: "completed",
    toolCalls: calls,
    toolCallCount: calls.length,
    critiqueVerdict: "pass",
    improvement: null,
    evalScore: 0.9,
    costCents: 1,
    latencyMs: 10,
    humanCorrected: false,
    skillApplied: false,
    createdAt: NOW,
  };
}

/** 24 calls, 6 of them refused for their arguments: an invalid-argument rate of 0.25. */
function degraded(badCalls = 6, total = 24): AgentTraceRow[] {
  return [
    row(
      "trace_1",
      Array.from({ length: total }, (_, i) =>
        encodeToolCall(
          i < badCalls
            ? { tool: "web_search", adapter: "web", status: "failed", error: 'invalid arguments: "limit" must be an integer', args: { limit: "five" } }
            : { tool: "web_search", adapter: "web", status: "completed", args: { query: `q${i}` } },
        ),
      ),
    ),
  ];
}

async function gates(store: ImproveStorePort): Promise<DraftGateContext> {
  return { store, now: NOW, vetoed: await vetoedHashes(store, COMPANY) };
}

const DESCRIPTION = "Search the live web. Returns ranked results.";

describe("proposeToolDrafts", () => {
  it("proposes one draft per tool over the threshold, carrying the evidence and the shipped description", async () => {
    const store = new InMemoryImproveStore();
    const report = await proposeToolDrafts({
      store,
      companyId: COMPANY,
      rows: degraded(),
      gates: await gates(store),
      now: NOW,
      descriptionFor: (tool) => (tool === "web_search" ? DESCRIPTION : undefined),
    });

    expect(report.proposed.map((p) => p.tool)).toEqual(["web_search"]);
    expect(report.proposed[0]?.decision).toBe("quarantined");

    const drafts = await store.listDrafts(COMPANY, { kind: "tool", status: "quarantine" });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.agentId).toBe(TOOL_DRAFT_AGENT);
    expect(draft.taskType).toBe("web_search");
    expect(draft.triggers).toContain("tool_health");

    const payload = decodeToolDraft(draft.content)!;
    expect(payload.tool).toBe("web_search");
    expect(payload.currentDescription).toBe(DESCRIPTION);
    expect(payload.evidence.calls).toBe(24);
    expect(payload.evidence.invalidArguments).toBe(6);
    expect(payload.evidence.invalidArgumentRate).toBe(0.25);
    expect(payload.evidence.examples).toHaveLength(3);
    expect(payload.proposedDescription).toContain(DESCRIPTION);

    // The iteration is visible to `trent improve status` like any other candidate.
    const iterations = await store.listIterations(COMPANY, { agentId: TOOL_DRAFT_AGENT });
    expect(iterations).toHaveLength(1);
    expect(iterations[0]?.candidateKind).toBe("tool");
    expect(iterations[0]?.candidateId).toBe(draft.id);
  });

  it("proposes nothing for a tool under the threshold", async () => {
    const store = new InMemoryImproveStore();
    const report = await proposeToolDrafts({ store, companyId: COMPANY, rows: degraded(2, 40), gates: await gates(store), now: NOW });
    expect(report.proposed).toEqual([]);
    expect(await store.listDrafts(COMPANY, { kind: "tool" })).toEqual([]);
  });

  it("the same proposal, once rejected, is vetoed before it is scored", async () => {
    const store = new InMemoryImproveStore();
    const first = await proposeToolDrafts({ store, companyId: COMPANY, rows: degraded(), gates: await gates(store), now: NOW, descriptionFor: () => DESCRIPTION });
    const draftId = first.proposed[0]!.draftId;
    await rejectDraft(store, draftId, "human", NOW);

    const second = await proposeToolDrafts({ store, companyId: COMPANY, rows: degraded(), gates: await gates(store), now: NOW, descriptionFor: () => DESCRIPTION });
    expect(second.proposed[0]?.decision).toBe("rejected");
    expect(second.proposed[0]?.blockedBy).toBe("content_vetoed");
    const ledger = await store.listLedger(COMPANY);
    expect(ledger.some((entry) => entry.actor === "gate:content_vetoed")).toBe(true);
  });

  it("a proposal already in quarantine is not proposed again", async () => {
    const store = new InMemoryImproveStore();
    await proposeToolDrafts({ store, companyId: COMPANY, rows: degraded(), gates: await gates(store), now: NOW, descriptionFor: () => DESCRIPTION });
    const again = await proposeToolDrafts({ store, companyId: COMPANY, rows: degraded(), gates: await gates(store), now: NOW, descriptionFor: () => DESCRIPTION });
    expect(again.proposed).toEqual([]);
    expect(again.skipped).toEqual([{ tool: "web_search", reason: "unchanged" }]);
    expect(await store.listDrafts(COMPANY, { kind: "tool" })).toHaveLength(1);
  });

  it("live: the proposed description comes from the reflection model, and its cost is the caller's", async () => {
    const store = new InMemoryImproveStore();
    const prompts: string[] = [];
    const report = await proposeToolDrafts({
      store,
      companyId: COMPANY,
      rows: degraded(),
      gates: await gates(store),
      now: NOW,
      descriptionFor: () => DESCRIPTION,
      propose: async (prompt) => {
        prompts.push(prompt);
        return "Search the live web. `limit` is an integer between 1 and 100.";
      },
    });
    expect(report.proposed).toHaveLength(1);
    expect(prompts[0]).toContain("web_search");
    expect(prompts[0]).toContain("0.25");
    const draft = (await store.listDrafts(COMPANY, { kind: "tool", status: "quarantine" }))[0]!;
    expect(decodeToolDraft(draft.content)?.proposedDescription).toBe("Search the live web. `limit` is an integer between 1 and 100.");
  });
});

describe("the sweep", () => {
  it("proposes once per tool over every seat's traces, and a second sweep proposes nothing new", async () => {
    const store = new InMemoryImproveStore();
    for (const trace of degraded()) await store.appendTrace(trace);

    const first = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true, now: () => NOW });
    expect(first.tools?.proposed.map((p) => p.tool)).toEqual(["web_search"]);
    expect(first.tools?.health.map((h) => h.tool)).toEqual(["web_search"]);
    expect(await store.listDrafts(COMPANY, { kind: "tool", status: "quarantine" })).toHaveLength(1);

    const second = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true, now: () => NOW });
    expect(second.tools?.proposed).toEqual([]);
    expect(second.tools?.skipped).toEqual([{ tool: "web_search", reason: "unchanged" }]);
  });
});

describe("the offline proposal", () => {
  it("is deterministic and cites the measured rates rather than inventing a description", () => {
    const health = {
      tool: "web_search",
      calls: 24,
      failures: 6,
      failureRate: 0.25,
      invalidArguments: 6,
      invalidArgumentRate: 0.25,
      retries: 6,
      retryRate: 0.25,
      meanArgsBytes: 20,
      examples: ['invalid arguments: "limit" must be an integer'],
    };
    const first = offlineToolProposal(health, DESCRIPTION);
    expect(offlineToolProposal(health, DESCRIPTION)).toBe(first);
    expect(first).toContain(DESCRIPTION);
    expect(first).toContain("0.25");
    expect(first).toContain('invalid arguments: "limit" must be an integer');
    // It asks for a rewrite; it does not pretend to be one.
    expect(toolProposalPrompt(health, DESCRIPTION)).toContain("web_search");
  });
});
