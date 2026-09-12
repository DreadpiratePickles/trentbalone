import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the Phase-1 audit finding: every active "run cycle" entry point routes
 * through the durable orchestrator (launchOrchestration), and the legacy linear
 * runCompanyCycle is not wired into any of them. A source-guard test because the
 * cycle job dynamically imports launchOrchestration (awkward to mock end-to-end).
 */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

describe("run button truth — durable orchestrator path", () => {
  it("the company_scheduled_cycle job launches the durable orchestrator with the scheduled cycle kind", () => {
    const queue = read("lib/queue.ts");
    const handler = queue.slice(queue.indexOf('if (type === "company_scheduled_cycle")'));
    expect(handler).toContain("launchOrchestration");
    expect(handler).toContain('cycleKind: "scheduled"');
  });

  it("the scheduled cycle sweep launches the durable orchestrator", () => {
    expect(read("lib/scheduler.ts")).toContain("launchOrchestration");
  });

  it("the cycles API route enqueues the durable company cycle and never imports the legacy runner", () => {
    const route = read("app/api/companies/[id]/orchestrate/route.ts");
    expect(route).toContain("launchOrchestration");

    const cyclesRoute = read("app/api/companies/[id]/cycles/route.ts");
    expect(cyclesRoute).toContain("enqueueCompanyCycle");
    expect(cyclesRoute).not.toContain("runCompanyCycle");
  });

  it("no active run-cycle entry point imports the legacy runCompanyCycle", () => {
    const activeEntryPoints = [
      "lib/queue.ts",
      "lib/scheduler.ts",
      "lib/orchestrator-run-worker.ts",
      "app/api/companies/[id]/cycles/route.ts",
      "app/api/companies/[id]/orchestrate/route.ts",
      "components/shell.tsx",
    ];
    for (const file of activeEntryPoints) {
      expect(read(file), `${file} must not call the legacy runCompanyCycle`).not.toMatch(/\brunCompanyCycle\s*\(/);
    }
  });
});
