import { describe, it, expect } from "vitest";
import { AGENT_CATALOG } from "../agents/index.js";
import { CORE_ROLES } from "./AgentInstaller.js";
import { FLEET_PACKS, resolveFleetPack } from "./FleetPacks.js";

describe("FLEET_PACKS", () => {
  const catalogIds = new Set(AGENT_CATALOG.map((a) => a.id));
  const coreIds = new Set(Object.keys(CORE_ROLES));

  it("names every agent it advertises with a resolvable id", () => {
    for (const pack of Object.values(FLEET_PACKS)) {
      for (const id of pack.agents) {
        expect(catalogIds.has(id) || coreIds.has(id), `${pack.id} -> ${id}`).toBe(true);
      }
    }
  });

  it("lists no duplicate agents inside a pack", () => {
    for (const pack of Object.values(FLEET_PACKS)) {
      expect(new Set(pack.agents).size, `pack ${pack.id}`).toBe(pack.agents.length);
    }
  });

  it("keys every pack by its own id", () => {
    for (const [key, pack] of Object.entries(FLEET_PACKS)) {
      expect(pack.id).toBe(key);
    }
  });

  // Defect 3: the label claimed 164 specialists while the pack held nine core roles.
  it("backs the full-fleet pack's label with all 164 specialists", () => {
    const all = FLEET_PACKS.all;
    expect(all).toBeDefined();
    expect(all?.agents.length).toBe(164);
    expect(all?.name).toContain("164");
    expect(new Set(all?.agents)).toEqual(catalogIds);
  });

  it("offers a separate pack for the nine core roles", () => {
    const core = FLEET_PACKS["core-roles"];
    expect(core).toBeDefined();
    expect(core?.agents.length).toBe(9);
    expect(new Set(core?.agents)).toEqual(coreIds);
  });

  it("resolves pack aliases to a real pack", () => {
    expect(resolveFleetPack("engineering")?.id).toBe("engineering");
    expect(resolveFleetPack("ALL")?.id).toBe("all");
    expect(resolveFleetPack("no-such-pack")).toBeUndefined();
  });
});
