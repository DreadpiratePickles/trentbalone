import { describe, it, expect } from "vitest";
import {
  specializationSlug,
  derivedTaskTypeKey,
  buildDerivedSkillContent,
  buildDerivePrompt,
  deriveSpecializedSkill,
  proposeDerivedSkillsForCompany,
} from "@/lib/skill-derive";
import { InMemorySkillDraftStore } from "@/lib/skill-foundry";

async function liveStore(companyId: string, taskTypes: string[]): Promise<InMemorySkillDraftStore> {
  const store = new InMemorySkillDraftStore();
  for (const tt of taskTypes) {
    await store.writeQuarantine(companyId, tt, `## Steps\n1. do ${tt}`);
    await store.promote(companyId, tt);
  }
  return store;
}

describe("specializationSlug", () => {
  it("slugifies free text and clamps empties", () => {
    expect(specializationSlug("B2B SaaS Founders!")).toBe("b2b-saas-founders");
    expect(specializationSlug("   ")).toBe("variant");
  });
});

describe("derivedTaskTypeKey", () => {
  it("composes parent@slug and stays idempotent", () => {
    expect(derivedTaskTypeKey("cold_outreach", "B2B SaaS")).toBe("cold_outreach@b2b-saas");
    expect(derivedTaskTypeKey("cold_outreach@b2b-saas", "anything")).toBe("cold_outreach@b2b-saas");
  });
});

describe("buildDerivedSkillContent", () => {
  it("stamps lineage and preserves the parent body", () => {
    const content = buildDerivedSkillContent(
      "## Steps\n1. Research prospect",
      "cold_outreach",
      "B2B SaaS",
      "Lead with integration depth; skip discount framing.",
      "2026-06-07T00:00:00.000Z",
    );
    expect(content).toContain("kind: derived");
    expect(content).toContain("parent: cold_outreach");
    expect(content).toContain("## Steps");
    expect(content).toContain("## Specialization — B2B SaaS");
    expect(content).toContain("integration depth");
  });
});

describe("buildDerivePrompt", () => {
  it("instructs minimal, structure-preserving specialization", () => {
    const p = buildDerivePrompt("PARENT", "cold_outreach", "B2B SaaS", "spec notes");
    expect(p).toContain("DERIVED mode");
    expect(p).toContain("cold_outreach");
    expect(p).toContain("spec notes");
  });
});

describe("deriveSpecializedSkill", () => {
  it("returns null when the parent has no live skill", async () => {
    const store = new InMemorySkillDraftStore();
    const draft = await deriveSpecializedSkill("cold_outreach", {
      companyId: "c1",
      draftStore: store,
      label: "B2B SaaS",
      specialization: "x",
      skipLLM: true,
    });
    expect(draft).toBeNull();
  });

  it("forks a quarantined child from a live parent with lineage", async () => {
    const store = new InMemorySkillDraftStore();
    await store.writeQuarantine("c1", "cold_outreach", "## Steps\n1. Research prospect");
    await store.promote("c1", "cold_outreach");

    const audits: string[] = [];
    const draft = await deriveSpecializedSkill("cold_outreach", {
      companyId: "c1",
      draftStore: store,
      label: "B2B SaaS",
      specialization: "Lead with integration depth.",
      skipLLM: true,
      auditLog: (async (_companyId: string, _actor: string, action: string) => {
        audits.push(action);
      }) as never,
      id: "skill_fixed",
    });

    expect(draft).not.toBeNull();
    expect(draft!.kind).toBe("derived");
    expect(draft!.taskType).toBe("cold_outreach@b2b-saas");
    expect(draft!.parentTaskType).toBe("cold_outreach");
    expect(draft!.specializationLabel).toBe("b2b-saas");
    expect(audits).toContain("skill.derived");

    // Child lives in quarantine under its derived key; parent untouched.
    const child = await store.readQuarantine("c1", "cold_outreach@b2b-saas");
    expect(child).toContain("## Specialization — B2B SaaS");
    expect(await store.readLive("c1", "cold_outreach")).toContain("Research prospect");
  });
});

describe("proposeDerivedSkillsForCompany", () => {
  it("derives ICP variants for live parents, capped", async () => {
    const store = await liveStore("c1", ["cold_outreach", "qualification", "follow_up"]);
    const drafts = await proposeDerivedSkillsForCompany({
      companyId: "c1",
      draftStore: store,
      label: "B2B SaaS",
      specialization: "Lead with integration depth.",
      maxDerivations: 2,
      skipLLM: true,
    });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.kind === "derived")).toBe(true);
  });

  it("is idempotent — skips a parent whose variant already exists", async () => {
    const store = await liveStore("c1", ["cold_outreach"]);
    const first = await proposeDerivedSkillsForCompany({
      companyId: "c1", draftStore: store, label: "B2B SaaS", specialization: "x", skipLLM: true,
    });
    expect(first).toHaveLength(1);
    const second = await proposeDerivedSkillsForCompany({
      companyId: "c1", draftStore: store, label: "B2B SaaS", specialization: "x", skipLLM: true,
    });
    expect(second).toHaveLength(0);
  });

  it("never derives from an already-derived skill", async () => {
    const store = await liveStore("c1", ["cold_outreach@b2b-saas"]);
    const drafts = await proposeDerivedSkillsForCompany({
      companyId: "c1", draftStore: store, label: "Enterprise", specialization: "x", skipLLM: true,
    });
    expect(drafts).toHaveLength(0);
  });
});
