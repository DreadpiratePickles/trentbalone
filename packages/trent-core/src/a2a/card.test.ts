/**
 * W5 — the Agent Card's skills are tagged by TOOLSET. Hermes's `a2a_orchestrate(capability, ...)`
 * fans a message out to the peers whose skills advertise that capability as a tag
 * (`01_discovery/output/hermes-feature-inventory-2026-09.md`, Messaging/A2A), so a tag has to be a
 * name a peer can ask for: the seat's Trent toolsets, read from the seat's own capability record,
 * not a category label or a model policy nobody fans out on.
 */
import { describe, expect, it } from "vitest";

import { CORE_ROLES } from "../fleet/AgentInstaller.js";
import { seatCapability } from "../fleet/seat-capabilities.js";
import { agentCardSkills, buildAgentCard } from "./card.js";

describe("agentCardSkills tags", () => {
  it("equal the seat's toolsets, in the seat's own order, for every seat on the card", () => {
    const skills = agentCardSkills();
    expect(skills.map((skill) => skill.id)).toEqual(Object.keys(CORE_ROLES));
    for (const skill of skills) {
      expect(skill.tags).toEqual([...seatCapability(skill.id).toolsets]);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  it("differ between seats whose manifests differ, so a peer can pick a seat by capability", () => {
    const byId = new Map(agentCardSkills().map((skill) => [skill.id, skill.tags]));
    // The engineer's manifest maps to the terminal; the finance seat's does not.
    expect(byId.get("engineer")).toContain("terminal");
    expect(byId.get("finance")).not.toContain("terminal");
  });

  it("carries the same tags on the served card", () => {
    const card = buildAgentCard({ url: "http://127.0.0.1:7895/", version: "0.0.0-test" });
    for (const skill of card.skills) expect(skill.tags).toEqual([...seatCapability(skill.id).toolsets]);
  });
});
