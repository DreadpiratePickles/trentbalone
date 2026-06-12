import { describe, expect, it } from "vitest";
import { AGENT_SLOTS, buildSlotEnvironment } from "@/lib/agent-catalog";
import { INTERNAL_ACTIONS, runInternalAction } from "@/lib/internal-actions";
import {
  buildAdvertisedToolSet,
  buildSeatToolContracts,
  contractsForSeat,
  orphans,
  phantoms,
  type SeatToolContract,
  type ToolReadiness,
} from "@/lib/seat-tool-contracts";
import { adapters, type ToolAdapter } from "@/lib/tools";
import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";

const COMPANY_ID = "co_seat_tool_contracts";
const ROLES = AGENT_SLOTS.map((slot) => slot.role) as AgentRole[];

function slotEnvironments(): Record<AgentRole, AgentEnvironmentConfig> {
  return Object.fromEntries(
    ROLES.map((role) => [role, buildSlotEnvironment(COMPANY_ID, role)]),
  ) as Record<AgentRole, AgentEnvironmentConfig>;
}

function healthFor(registry: ToolAdapter[], override?: Record<string, ToolReadiness>) {
  return new Map(registry.map((adapter) => [
    adapter.name,
    override?.[adapter.name] ?? readinessFromAvailability(adapter),
  ]));
}

function readinessFromAvailability(adapter: ToolAdapter): ToolReadiness {
  if (adapter.availability === "test_only") return "mocked";
  if (adapter.availability === "unavailable") return "unavailable";
  return "needs_credentials";
}

function buildContracts(input: {
  registry?: ToolAdapter[];
  health?: Map<string, ToolReadiness>;
  internalActions?: ReadonlySet<string>;
  mcpToolNames?: ReadonlySet<string>;
} = {}) {
  const registry = input.registry ?? stableAdapters(adapters);
  return buildSeatToolContracts({
    slotEnvironments: slotEnvironments(),
    adapters: registry,
    internalActions: input.internalActions ?? INTERNAL_ACTIONS,
    mcpToolNames: input.mcpToolNames ?? new Set(),
    healthByAdapter: input.health ?? healthFor(registry),
  });
}

function stableAdapters(registry: ToolAdapter[]): ToolAdapter[] {
  return registry.map((adapter) => {
    if (adapter.name !== "Workbench Sandbox") return adapter;
    return {
      ...adapter,
      availability: "test_only",
      async healthCheck() {
        return "mocked";
      },
    };
  });
}

function expectedRowsForSeat(role: AgentRole, env = slotEnvironments()) {
  return env[role].tools.map((tool) => `${role} -> ${tool}`);
}

function contractRows(contracts: SeatToolContract[]) {
  return contracts.map((contract) => `${contract.seat} -> ${contract.tool}`);
}

function formatRows(rows: string[]) {
  return rows.length ? `\n${rows.sort().join("\n")}` : "\n(none)";
}

function fullContractTable(contracts: SeatToolContract[]) {
  return contracts
    .map((contract) => [
      contract.seat,
      contract.tool,
      contract.binding,
      contract.resolvedAdapter ?? "-",
      contract.readiness,
      contract.advertised ? "advertised" : "phantom",
      contract.approvalRequired ? "approval" : "no_approval",
      contract.writeCapable ? "write" : "read",
    ].join(" | "))
    .sort()
    .join("\n");
}

describe("seat-tool contracts", () => {
  it("every seat tool string has a non-null binding", () => {
    const env = slotEnvironments();
    const contracts = buildContracts();
    const actual = new Set(contractRows(contracts));
    const missing = ROLES.flatMap((role) => expectedRowsForSeat(role, env).filter((row) => !actual.has(row)));
    const unbound = contracts
      .filter((contract) => !contract.binding)
      .map((contract) => `${contract.seat} -> ${contract.tool}`);

    expect(
      [...missing, ...unbound],
      `Unbound or missing seat tools:${formatRows([...missing, ...unbound])}\n\nFull table:\n${fullContractTable(contracts) || "(empty)"}`,
    ).toEqual([]);
  });

  it("no phantom tools", () => {
    const contracts = buildContracts();
    const list = phantoms(contracts).map((contract) => `${contract.seat} -> ${contract.tool} (${contract.binding})`);

    expect(list, `Phantom tools:${formatRows(list)}\n\nFull table:\n${fullContractTable(contracts) || "(empty)"}`).toEqual([]);
  });

  it("readiness is derived, not literal", () => {
    const stub: ToolAdapter = {
      name: "Stub Tool",
      scopes: ["stub:read"],
      availability: "real",
      async healthCheck() { return "mocked"; },
      estimateCost() { return 0; },
      requiresApproval() { return false; },
      async execute(action) {
        return { adapter: "Stub Tool", action, status: "completed", summary: "ok" };
      },
    };
    const env = slotEnvironments();
    env.ceo = { ...env.ceo, tools: ["Stub Tool"] };
    const contracts = buildSeatToolContracts({
      slotEnvironments: env,
      adapters: [stub],
      internalActions: new Set(),
      mcpToolNames: new Set(),
      healthByAdapter: new Map([["Stub Tool", "mocked"]]),
    });

    expect(contracts.find((contract) => contract.tool === "Stub Tool")?.readiness).toBe("mocked");
  });

  it("internal actions all have an executor", async () => {
    const contracts = buildContracts();
    const internal = contracts.filter((contract) => contract.binding === "internal_action");
    const missing = internal
      .filter((contract) => !INTERNAL_ACTIONS.has(contract.tool))
      .map((contract) => `${contract.seat} -> ${contract.tool}`);

    expect(internal.length, `Expected internal actions in contract table.\n\nFull table:\n${fullContractTable(contracts) || "(empty)"}`).toBeGreaterThan(0);
    expect(missing, `Internal actions missing executor:${formatRows(missing)}`).toEqual([]);

    for (const contract of internal) {
      const result = await runInternalAction(contract.tool, "contract smoke test", { companyId: COMPANY_ID });
      expect(
        result.status,
        `Internal action ${contract.tool} returned a fake/mock status: ${JSON.stringify(result)}`,
      ).not.toBe("mocked");
    }
  });

  it("write-capable tools are approval-gated", () => {
    const contracts = buildContracts();
    const ungated = contracts
      .filter((contract) => contract.writeCapable && !contract.approvalRequired)
      .map((contract) => `${contract.seat} -> ${contract.tool}`);

    expect(ungated, `Ungated write-capable tools:${formatRows(ungated)}`).toEqual([]);
  });

  it("unavailable markers never report connected", async () => {
    const contracts = buildContracts();
    const unavailableContracts = contracts.filter((contract) => contract.binding === "unavailable_marker");
    const connectedUnavailable = unavailableContracts
      .filter((contract) => contract.readiness === "connected")
      .map((contract) => `${contract.seat} -> ${contract.tool}`);

    expect(connectedUnavailable, `Unavailable markers reporting connected:${formatRows(connectedUnavailable)}`).toEqual([]);

    for (const adapter of adapters.filter((item) => item.availability === "unavailable")) {
      const contractsForAdapter = contracts.filter((contract) => contract.resolvedAdapter === adapter.name);
      expect(
        contractsForAdapter.map((contract) => contract.readiness),
        `Unavailable adapter ${adapter.name} readiness was not unavailable.`,
      ).not.toContain("connected");
      const result = await adapter.execute("contract smoke test", { companyId: COMPANY_ID });
      expect(result.status).toBe("failed");
    }
  });

  it("no test_only adapter is advertised as connected anywhere", () => {
    const contracts = buildContracts();
    const testOnlyNames = new Set(adapters.filter((adapter) => adapter.availability === "test_only").map((adapter) => adapter.name));
    const falseGreen = contracts
      .filter((contract) => contract.resolvedAdapter && testOnlyNames.has(contract.resolvedAdapter) && contract.readiness === "connected")
      .map((contract) => `${contract.seat} -> ${contract.tool} (${contract.resolvedAdapter})`);

    expect(falseGreen, `Test-only adapters advertised as connected:${formatRows(falseGreen)}`).toEqual([]);
  });

  it("runtime availableTools === contract.advertised set", () => {
    const contracts = buildContracts();
    const mismatches = ROLES.flatMap((role) => {
      const expected = new Set(slotEnvironments()[role].tools);
      const advertised = buildAdvertisedToolSet(contracts, role);
      const missing = [...expected].filter((tool) => !advertised.has(tool));
      const extra = [...advertised].filter((tool) => !expected.has(tool));
      return [...missing.map((tool) => `${role} missing ${tool}`), ...extra.map((tool) => `${role} extra ${tool}`)];
    });

    expect(mismatches, `Runtime/contract availableTools mismatch:${formatRows(mismatches)}`).toEqual([]);
  });

  it("every seat in AgentRole has a contract block", () => {
    const contracts = buildContracts();
    const missing = ROLES.filter((role) => contractsForSeat(contracts, role).length === 0);

    expect(missing, `Seats missing contract blocks:${formatRows(missing)}`).toEqual([]);
  });

  it("contract is stable & total", () => {
    const contracts = buildContracts();
    expect(contracts.length).toBeGreaterThan(0);
    expect(orphans(contracts)).toEqual([]);
    expect(fullContractTable(contracts)).toMatchSnapshot();
  });
});
