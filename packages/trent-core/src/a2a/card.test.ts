/**
 * W5 — the Agent Card's skills are tagged by TOOLSET. A tag is the word a peer's operator asks
 * for: Hermes's `a2a_orchestrate(capability, ...)` matches it against the `capabilities` list
 * that operator writes under `a2a_agents.<peer>` in its config.yaml (Hermes v0.21.3
 * `plugins/platforms/a2a/tools.py`; `docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md`),
 * so the tags are the seat's Trent toolsets, read from the seat's own capability record, not a
 * category label or a model policy nobody would copy into that list.
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
