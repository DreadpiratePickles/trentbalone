import { describe, expect, it } from "vitest";
import { createContextChunkPlan, scoreContextFile } from "./context";

describe("app builder context planning", () => {
  it("scores app, schema, package, and test files ahead of generated assets", () => {
    expect(scoreContextFile("app/api/users/route.ts")).toBeGreaterThan(scoreContextFile("public/logo.png"));
    expect(scoreContextFile("prisma/schema.prisma")).toBeGreaterThan(scoreContextFile("README.md"));
    expect(scoreContextFile("package.json")).toBeGreaterThan(scoreContextFile("dist/bundle.js"));
  });

  it("builds deterministic chunks under a 1M-token budget", () => {
    const plan = createContextChunkPlan({
      files: [
        { path: "public/logo.png", estimatedTokens: 200_000 },
        { path: "package.json", estimatedTokens: 1_000 },
        { path: "app/page.tsx", estimatedTokens: 10_000 },
        { path: "prisma/schema.prisma", estimatedTokens: 5_000 },
      ],
      tokenBudget: 20_000,
      maxChunkTokens: 12_000,
    });

    expect(plan.totalSelectedTokens).toBeLessThanOrEqual(20_000);
    expect(plan.chunks[0]).toEqual(expect.objectContaining({ id: "ctx_001" }));
    expect(plan.chunks.flatMap((chunk) => chunk.files.map((file) => file.path))).toEqual([
      "package.json",
      "prisma/schema.prisma",
      "app/page.tsx",
    ]);
  });
});
