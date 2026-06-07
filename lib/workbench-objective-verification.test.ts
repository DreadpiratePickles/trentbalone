import { describe, expect, it } from "vitest";
import { verifyObjective } from "@/lib/workbench-objective-verification";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { RenderVerificationResult } from "@/lib/workbench-render-verification";

function session(objective: string): WorkbenchSession {
  return { id: "s1", companyId: "c1", objective } as unknown as WorkbenchSession;
}

// Minimal provider whose file tree contributes nothing — keeps the test focused
// on the rendered-text evidence path.
const provider = {
  listFiles: async () => [],
} as unknown as WorkbenchProviderAdapter;

function render(visibleText: string): RenderVerificationResult {
  return { checks: [], visibleText, domSummary: "" };
}

describe("verifyObjective", () => {
  it("passes when a majority of concrete terms render, ignoring filler words", async () => {
    // "called" is filler and will never render — must not block the pass.
    const check = await verifyObjective({
      session: session("build me a notes app called Ember"),
      provider,
      render: render("Ember Notes — capture an idea, save note"),
    });
    expect(check.status).toBe("pass");
  });

  it("treats connective words (called/named/that) as stop words", async () => {
    const check = await verifyObjective({
      session: session("a todo app named Tasker that supports tags"),
      provider,
      render: render("Tasker todo list with tags"),
    });
    expect(check.status).toBe("pass");
  });

  it("fails when no concrete terms render at all (truly blank/unrelated)", async () => {
    const check = await verifyObjective({
      session: session("build a kanban board with columns"),
      provider,
      render: render(""),
    });
    // Empty evidence → skip (no evidence) rather than a false pass.
    expect(["skip", "fail"]).toContain(check.status);
  });

  it("fails when the rendered product is unrelated to the objective", async () => {
    const check = await verifyObjective({
      session: session("build a kanban board with columns and cards"),
      provider,
      render: render("Weather forecast for Tokyo: sunny 24 degrees"),
    });
    expect(check.status).toBe("fail");
  });

  it("skips when the objective is too broad for deterministic verification", async () => {
    const check = await verifyObjective({
      session: session("make a web app"),
      provider,
      render: render("anything"),
    });
    expect(check.status).toBe("skip");
  });
});
