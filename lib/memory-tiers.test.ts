import { describe, expect, it } from "vitest";
import { SemanticMemory, WorkingMemory, writeEpisodicMemory } from "@/lib/memory-tiers";
import { store } from "@/lib/store";

describe("memory tiers", () => {
  it("bounds working memory and stores a close summary", () => {
    const memory = new WorkingMemory("test", 2);

    memory.push("system", "You are Trent.");
    memory.push("user", "First request");
    memory.push("assistant", "First answer");

    expect(memory.messages()).toHaveLength(2);
    expect(memory.messages()[0]?.role).toBe("system");

    memory.close("The run completed.");
    expect(memory.messages()).toEqual([]);
    expect(memory.summary).toBe("The run completed.");
  });

  it("writes episodic memory at cycle close", async () => {
    const company = await store.createCompany({
      name: "Memory Episode Co",
      brief: { vision: "Remember useful operating history" }
    });

    await writeEpisodicMemory({
      companyId: company.id,
      cycleId: "cycle_test_1",
      trigger: "manual",
      summary: "CEO set the weekly plan.",
      agentResults: [
        { role: "ceo", success: true, summary: "Picked the retention sprint." },
        { role: "growth", success: false, summary: "Blocked on analytics access." }
      ]
    });

    const docs = await store.listDocuments(company.id);
    const episodic = docs.find((doc) => doc.source === "cycle:cycle_test_1");
    expect(episodic?.memoryTier).toBe("episodic");
    expect(episodic?.content).toContain("CEO set the weekly plan.");
    expect(episodic?.content).toContain("Blocked on analytics access.");
  });

  it("expires superseded semantic memory and excludes expired facts from search", async () => {
    const company = await store.createCompany({
      name: "Semantic Memory Co",
      brief: { vision: "Keep current facts authoritative" }
    });

    const oldFact = await store.createDocument({
      companyId: company.id,
      type: "agent_note",
      title: "[semantic] mrr",
      content: "MRR is $10k as of April.",
      source: "cycle:old",
      memoryTier: "semantic",
      validFrom: new Date(2026, 3, 1).toISOString()
    });

    const semantic = new SemanticMemory(company.id);
    semantic.add({
      factType: "mrr",
      content: "MRR is $20k as of May.",
      source: "cycle:new",
      supersedesId: oldFact.id
    });
    const [newFact] = await semantic.flush();

    const docs = await store.listDocuments(company.id);
    const expired = docs.find((doc) => doc.id === oldFact.id);
    expect(expired?.validTo).toBeTruthy();
    expect(newFact?.supersedesId).toBe(oldFact.id);

    const results = await store.searchMemory(company.id, "MRR");
    expect(results.some((result) => result.id === oldFact.id)).toBe(false);
    expect(results.some((result) => result.id === newFact?.id)).toBe(true);
  });
});
