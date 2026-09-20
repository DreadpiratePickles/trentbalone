import { describe, it, expect } from "vitest";
import { AGENT_CATALOG } from "../agents/index.js";
import { BRAIN_SYSTEM_LIMIT_CHARS } from "../fleet-memory/brain.js";
import { CORE_ROLES } from "./AgentInstaller.js";
import { FLEET_PACKS, PERSONA_LIMIT_CHARS, isFleetPackId, packPersona, personaPathFor, resolveFleetPack } from "./FleetPacks.js";
import { listSourceSkills } from "./SkillProvisioner.js";

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

  it("describes the core-roles pack with the seats it actually installs", () => {
    const core = FLEET_PACKS["core-roles"];
    const described = core?.description.toLowerCase() ?? "";
    for (const id of core?.agents ?? []) {
      expect(described, `the description omits the ${id} seat`).toContain(id);
    }
    expect(described, "the description still names a seat that is not in the pack").not.toContain("browser");
  });

  it("resolves pack aliases to a real pack", () => {
    expect(resolveFleetPack("engineering")?.id).toBe("engineering");
    expect(resolveFleetPack("ALL")?.id).toBe("all");
    expect(resolveFleetPack("no-such-pack")).toBeUndefined();
  });
});

/**
 * The three market packs (design v2, decision A3). A pack is a grouping, a persona and a set of
 * skills over the existing seats; it is not a runnable agent, and its `state` line says exactly
 * what executes today and what stays a draft until a toolset lands.
 */
describe("the small-business, social and creator packs", () => {
  const sourceNames = new Set(listSourceSkills().map((entry) => entry.name));

  it("group the seats and specialists the audit named", () => {
    expect(FLEET_PACKS["small-business"]?.agents).toEqual(["support", "sales", "finance", "content"]);
    expect(FLEET_PACKS.social?.agents).toEqual(["content", "growth", "analyst", "mkt-social-media-strategist", "mkt-content-creator"]);
    expect(FLEET_PACKS.creator?.agents).toEqual([
      "content",
      "mkt-short-video-editing-coach",
      "mkt-video-optimization-specialist",
      "design-image-prompt-engineer",
    ]);
  });

  it("carry the trade skills, every one of them resolvable from a skill source", () => {
    expect(FLEET_PACKS["small-business"]?.skills).toEqual([
      "quote-estimate",
      "invoice-draft",
      "booking-followup",
      "review-response",
      "local-business-post",
    ]);
    expect(FLEET_PACKS.social?.skills).toEqual(["content-calendar", "brand-voice-capture", "crosspost-adapt", "comment-triage"]);
    expect(FLEET_PACKS.creator?.skills).toEqual(["hook-lab", "caption-and-chapters", "repurpose-plan", "thumbnail-brief"]);
    for (const pack of Object.values(FLEET_PACKS)) {
      for (const skill of pack.skills) {
        expect(sourceNames.has(skill), `${pack.id} names skill ${skill}, which no source carries`).toBe(true);
      }
    }
  });

  it("every pack states what executes today; the three market packs name what stays a draft", () => {
    for (const pack of Object.values(FLEET_PACKS)) {
      expect(pack.state.trim().length, `${pack.id} has no state line`).toBeGreaterThan(20);
    }
    const business = FLEET_PACKS["small-business"]?.state.toLowerCase() ?? "";
    for (const effect of ["sent", "booked", "invoiced", "posted"]) expect(business).toContain(effect);
    expect(business).toContain("toolset");
    const social = FLEET_PACKS.social?.state.toLowerCase() ?? "";
    expect(social).toContain("published");
    expect(social).toContain("toolset");
    const creator = FLEET_PACKS.creator?.state.toLowerCase() ?? "";
    for (const effect of ["clipping", "transcription"]) expect(creator).toContain(effect);
    expect(creator).toContain("text");
  });

  it("carry a persona that names every member, fits the stable tier, and is the same bytes every read", () => {
    for (const id of ["small-business", "social", "creator"]) {
      const pack = FLEET_PACKS[id]!;
      const persona = packPersona(pack);
      expect(persona, `${id} has no persona`).not.toBeNull();
      expect(persona!.length, `${id} persona is ${String(persona!.length)} chars`).toBeLessThan(PERSONA_LIMIT_CHARS);
      expect(PERSONA_LIMIT_CHARS).toBeLessThan(BRAIN_SYSTEM_LIMIT_CHARS);
      for (const member of pack.agents) expect(persona, `${id} persona never names ${member}`).toContain(member);
      expect(persona).toContain(pack.id);
      expect(packPersona(pack)).toBe(persona);
      expect(personaPathFor(pack)).toBe(`system/persona-${id}.md`);
      // No inflated claims: a persona never says the crew sends, posts, books or charges.
      expect(persona!.toLowerCase()).not.toMatch(/\b(will|can) (send|post|publish|book|charge|invoice)\b/);
    }
    expect(packPersona(FLEET_PACKS.engineering!)).toBeNull();
  });

  it("answers exact pack ids only when asked whether a string is a pack", () => {
    expect(isFleetPackId("small-business")).toBe(true);
    expect(isFleetPackId("Small-Business ")).toBe(true);
    expect(isFleetPackId("eng")).toBe(false);
    expect(isFleetPackId("")).toBe(false);
  });
});
