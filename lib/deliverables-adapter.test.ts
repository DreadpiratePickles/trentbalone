import { describe, expect, it } from "vitest";
import { createDeliverablesAdapter } from "./deliverables-adapter";

describe("Deliverables adapter", () => {
  const adapter = createDeliverablesAdapter();

  it("is real, free, and never approval-gated", async () => {
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(adapter.availability).toBe("real");
    expect(adapter.estimateCost()).toBe(0);
    expect(adapter.requiresApproval("create")).toBe(false);
  });

  it("rejects an unknown format", async () => {
    const result = await adapter.execute("create", { format: "pdf", content: { title: "x" } });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("payload.format");
  });

  it("requires content with a title", async () => {
    const result = await adapter.execute("generate", { format: "markdown", content: {} });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("title");
  });

  it("builds a markdown deliverable from structured content", async () => {
    const result = await adapter.execute("create", {
      format: "markdown",
      content: { title: "Launch Plan", sections: [{ heading: "Goals", bullets: ["Ship v1"] }] },
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("launch-plan.md");
    expect(result.summary).toContain("# Launch Plan");
    expect(result.summary).toContain("- Ship v1");
  });

  it("fails a csv deliverable without a table, surfaced from the builder", async () => {
    const result = await adapter.execute("export", { format: "csv", content: { title: "Numbers" } });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("table");
  });
});
