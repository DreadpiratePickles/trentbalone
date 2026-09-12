import { describe, expect, it } from "vitest";
import { runWikiIndexRefresh } from "@/lib/trench-wiki-indexer";
import { store } from "@/lib/store";
import { createWorkbenchSession } from "@/lib/workbench";

describe("Trench Wiki indexer persistence", () => {
  it("builds and persists a semantic wiki index document from Workbench and memory sources", async () => {
    const company = await store.createCompany({
      name: `Wiki Indexer Co ${Date.now()}`,
      brief: { vision: "Keep workspace knowledge browsable" },
      budgetCents: 1000,
    });
    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "Implement payments route",
      enqueue: false,
    });
    await store.addWorkbenchEvent({
      companyId: company.id,
      sessionId: session.id,
      type: "file",
      status: "completed",
      title: "Edited payments route",
      content: "Changed app/api/payments/route.ts to use idempotency and audit logging.",
      command: "apply_patch app/api/payments/route.ts",
    });
    await store.createDocument({
      companyId: company.id,
      type: "agent_note",
      title: "Payment rule",
      content: "Payment writes require idempotency keys and audit logs.",
      source: "cycle:payment",
      memoryTier: "semantic",
    });

    const result = await runWikiIndexRefresh({
      companyId: company.id,
      sessionId: session.id,
      generatedAt: "2026-05-29T00:15:00.000Z",
    });

    expect(result.document.source).toBe("trench_wiki_indexer");
    expect(result.document.memoryTier).toBe("semantic");
    expect(result.index.pages.some((page) => page.summary.includes("payments"))).toBe(true);
    expect(JSON.parse(result.document.content).pages.length).toBe(result.index.pages.length);
  });
});
