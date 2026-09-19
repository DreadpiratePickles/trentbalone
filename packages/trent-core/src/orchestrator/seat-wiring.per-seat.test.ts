/**
 * B2 — per-seat adapters. Before this, `wireSeatTools` upserted ONE adapter list into all nine
 * seat environments and `buildTrentTools` had no seat parameter, so every seat advertised every
 * toolset and every capability its manifest names, including the ones the CLI cannot execute.
 */
import { describe, expect, it } from "vitest";

import { SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import { seatCapability } from "../fleet/seat-capabilities.js";
import { adaptersForSeat } from "../tools/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { seatEnvironment } from "./seat-wiring.js";
import type { SeatEnvironment } from "./libs.js";

function adapter(name: string, scopes: readonly string[]): TrentToolAdapter {
  return {
    name,
    scopes: [...scopes],
    availability: "real",
    instructions: `USE ${name} {json}`,
    async healthCheck() {
      return "connected";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval() {
      return false;
    },
    async execute(action: string) {
      return { adapter: name, action, status: "completed", summary: "" };
    },
    async cleanup() {
      /* nothing to release */
    },
  } as unknown as TrentToolAdapter;
}

const BUILT = [
  adapter("file_ops", ["read_file", "write_file"]),
  adapter("terminal", ["process_manage"]),
  adapter("code_execution", ["execute_code"]),
  adapter("web", ["web_search", "web_extract"]),
  adapter("skills", ["skills_list"]),
];

function baseFor(role: "engineer" | "finance"): SeatEnvironment {
  const template = SLOT_ENVIRONMENTS[role];
  return {
    memoryNamespace: `company:c1/agent:${role}`,
    tools: [...template.tools],
    approvalRequiredFor: [...template.approvalRequiredFor],
    budgetCentsPerRun: template.budgetCentsPerRun,
    maxRuntimeSeconds: template.maxRuntimeSeconds,
    outputContract: [...template.outputContract],
  };
}

describe("adaptersForSeat", () => {
  it("gives the engineer the shell and the finance seat none of it", () => {
    const engineer = adaptersForSeat(BUILT, "engineer").map((entry) => entry.name);
    expect(engineer).toEqual(["file_ops", "terminal", "code_execution", "web", "skills"]);

    const finance = adaptersForSeat(BUILT, "finance").map((entry) => entry.name);
    expect(finance).not.toContain("terminal");
    expect(finance).not.toContain("code_execution");
    expect(finance).not.toContain("file_ops");
    expect(finance).toEqual(["web", "skills"]);
  });

  it("keeps an adapter no toolset claims, rather than silently dropping a caller's registration", () => {
    const custom = [...BUILT, adapter("acme_ledger", ["acme:post"])];
    expect(adaptersForSeat(custom, "finance").map((entry) => entry.name)).toContain("acme_ledger");
  });
});

describe("seatEnvironment", () => {
  it("advertises the seat's manifest capabilities minus the unavailable ones, plus its own adapters", () => {
    const engineer = seatEnvironment("engineer", baseFor("engineer"), BUILT);
    // Mapped capabilities survive.
    expect(engineer.tools).toContain("workbench:session");
    expect(engineer.tools).toContain("documents:write");
    // The adapters the seat may actually call, by name AND scope (`resolveAdapter` matches either).
    expect(engineer.tools).toEqual(expect.arrayContaining(["file_ops", "read_file", "terminal", "code_execution"]));
    // Nothing advertises what does not exist here.
    for (const entry of seatCapability("engineer").unavailable) {
      expect(engineer.tools, entry.capability).not.toContain(entry.capability);
    }
    expect(engineer.tools).not.toContain("GitHub");
    expect(engineer.approvalRequiredFor).toEqual(expect.arrayContaining(["file_ops.write", "terminal.dangerous", "github.merge"]));
  });

  it("the finance seat's environment carries no shell at all", () => {
    const finance = seatEnvironment("finance", baseFor("finance"), BUILT);
    expect(finance.tools).not.toContain("terminal");
    expect(finance.tools).not.toContain("process_manage");
    expect(finance.tools).not.toContain("code_execution");
    expect(finance.tools).not.toContain("Stripe");
    expect(finance.tools).toContain("web");
    expect(finance.approvalRequiredFor).not.toContain("terminal.dangerous");
    expect(finance.approvalRequiredFor).toEqual(expect.arrayContaining(["payout", "refund"]));
  });
});
