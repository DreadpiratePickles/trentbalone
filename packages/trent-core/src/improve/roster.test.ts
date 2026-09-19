/**
 * [D1] the third roster. `trace-writer.ts` carried its own list of "the nine seats": it held
 * `browser`, which is a toolset and not a seat (no plan step can be assigned to it), and treated
 * `sales` as an installed specialist. So `resolveSweepScope` swept a phantom agent every sweep and
 * never swept the sales seat at all.
 *
 * There is one execution roster and the fleet exports it (`fleet/AgentInstaller.ts`
 * `CORE_ROLE_IDS`, itself read from the application's seats). This test is the join that stops a
 * third list appearing again: the improve loop's roster, the fleet's, and the application's
 * `SLOT_ENVIRONMENTS` keys are the same set.
 */
import { describe, expect, it } from "vitest";

import { CORE_ROLE_IDS } from "../fleet/AgentInstaller.js";
import { CORE_SEATS, SEAT_ROLES, resolveSweepScope } from "./index.js";

describe("[D1] the improve loop sweeps the execution roster", () => {
  it("cannot drift from the roster the fleet exports", () => {
    expect([...CORE_SEATS].sort()).toEqual([...CORE_ROLE_IDS].sort());
  });

  it("cannot drift from the application's own slot roles", async () => {
    const { SLOT_ENVIRONMENTS } = await import("@/lib/agent-catalog");
    expect([...CORE_SEATS].sort()).toEqual(Object.keys(SLOT_ENVIRONMENTS).sort());
  });

  it("sweeps sales and no browser seat", () => {
    const scope = resolveSweepScope({ installedAgents: [], traceCounts: {} });
    expect(scope.agents).toContain("sales");
    expect(scope.agents).not.toContain("browser");
  });

  it("a seat listed as an installed agent is never swept twice", () => {
    const scope = resolveSweepScope({ installedAgents: ["sales", "ceo"], traceCounts: { sales: 9, ceo: 9 } });
    expect(scope.agents.filter((id) => id === "sales")).toHaveLength(1);
    expect([...SEAT_ROLES].sort()).toEqual([...CORE_SEATS].sort());
  });
});
