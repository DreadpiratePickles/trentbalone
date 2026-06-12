import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, buildSlotEnvironment, SLOT_CONTRACTS } from "@/lib/agent-catalog";
import { clearAgentRuntimeCache, getAgentRuntime, getAgentRuntimeCacheStats } from "@/lib/agent-runtime";
import { store } from "@/lib/store";

describe("Agent Plug runtime", () => {
  it("splits static and dynamic prompt sections while embedding the seat manifest once", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Runtime Prompt Co",
      brief: { vision: "Keep prompts cacheable" }
    });

    const runtime = await getAgentRuntime(company.id, "engineer");

    expect(runtime.staticPrompt).toContain("Role: Lead Engineer");
    expect(runtime.dynamicPrompt).toContain("Memory namespace:");
    expect(runtime.systemPrompt).toBe(`${runtime.staticPrompt}\n\n${runtime.dynamicPrompt}`);
    expect(runtime.systemPrompt.match(/Definition of done/g) ?? []).toHaveLength(1);
  });

  it("reuses cached runtime data for repeated company-role lookups", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Runtime Cache Co",
      brief: { vision: "Avoid repeated prompt IO" }
    });

    await getAgentRuntime(company.id, "analyst");
    const first = getAgentRuntimeCacheStats();
    await getAgentRuntime(company.id, "analyst");
    const second = getAgentRuntimeCacheStats();

    expect(first.runtimeEntries).toBe(1);
    expect(second.runtimeEntries).toBe(1);
    expect(second.runtimeHits).toBe(first.runtimeHits + 1);
  });

  it("builds default environments for every slot", async () => {
    const [company] = await store.listCompanies();
    for (const role of Object.keys(SLOT_CONTRACTS) as Array<keyof typeof SLOT_CONTRACTS>) {
      const environment = buildSlotEnvironment(company.id, role);
      expect(environment.memoryNamespace).toBe(`company:${company.id}/agent:${role}`);
      expect(environment.tools.length).toBeGreaterThan(0);
      expect(environment.outputContract.length).toBeGreaterThan(0);
    }
  });

  it("gives every seat real Steel browser capabilities", async () => {
    const [company] = await store.listCompanies();
    for (const role of Object.keys(SLOT_CONTRACTS) as Array<keyof typeof SLOT_CONTRACTS>) {
      const environment = buildSlotEnvironment(company.id, role);
      expect(environment.tools).toEqual(expect.arrayContaining([
        "Steel Browser",
        "steel:scrape",
        "steel:screenshot",
        "steel:pdf",
      ]));
      expect(environment.approvalRequiredFor).toEqual(expect.arrayContaining([
        "steel.login",
        "steel.submit",
        "steel.purchase",
        "steel.download",
      ]));
    }

    const environment = buildSlotEnvironment(company.id, "sales");
    expect(environment.tools).toEqual(expect.arrayContaining(["crm:read_unavailable", "Email"]));
    expect(environment.tools).not.toContain("browser:mock");
  });

  it("grants real Phase 1 and sandbox tools to the seats that need them", async () => {
    const [company] = await store.listCompanies();
    const engineer = buildSlotEnvironment(company.id, "engineer");
    const analyst = buildSlotEnvironment(company.id, "analyst");
    const finance = buildSlotEnvironment(company.id, "finance");
    const growth = buildSlotEnvironment(company.id, "growth");
    const support = buildSlotEnvironment(company.id, "support");

    expect(engineer.tools).toEqual(expect.arrayContaining(["GitHub", "Workbench Sandbox", "tests:run", "sandbox:exec"]));
    expect(analyst.tools).toEqual(expect.arrayContaining(["PostHog", "Sentry", "Stripe", "Workbench Sandbox"]));
    expect(finance.tools).toEqual(expect.arrayContaining(["Stripe", "billing:read"]));
    expect(growth.tools).toEqual(expect.arrayContaining(["Email", "X", "PostHog"]));
    expect(support.tools).toEqual(expect.arrayContaining(["Email", "support:inbound_email"]));

    expect(engineer.tools).not.toContain("tests:mock");
    expect(analyst.tools).not.toContain("analytics:read_mock");
    expect(finance.tools).not.toContain("billing:mock");
    expect(support.tools).not.toContain("support:read_mock");
  });

  it("grants HyperFrames video creation only to the growth seat", async () => {
    const [company] = await store.listCompanies();
    const growth = buildSlotEnvironment(company.id, "growth");
    const engineer = buildSlotEnvironment(company.id, "engineer");

    expect(growth.tools).toEqual(expect.arrayContaining([
      "HyperFrames",
      "hyperframes:create",
      "hyperframes:render",
      "Open Generative AI",
      "open_gen_ai:image_generate",
      "open_gen_ai:video_generate",
    ]));
    expect(growth.skills).toEqual(expect.arrayContaining(["hyperframes", "hyperframes-cli"]));
    expect(growth.approvalRequiredFor).toEqual(expect.arrayContaining([
      "hyperframes.publish",
      "hyperframes.external_upload",
      "open_gen_ai.publish",
      "open_gen_ai.ads_launch",
    ]));

    expect(engineer.tools).not.toContain("HyperFrames");
    expect(engineer.tools).not.toContain("Open Generative AI");
    expect(engineer.skills ?? []).not.toContain("hyperframes");
  });

  it("grants Fincept Terminal sandbox capabilities only to the finance seat", async () => {
    const [company] = await store.listCompanies();
    const finance = buildSlotEnvironment(company.id, "finance");
    const growth = buildSlotEnvironment(company.id, "growth");

    expect(finance.tools).toEqual(expect.arrayContaining([
      "Fincept Terminal",
      "fincept:launch_sandbox",
      "fincept:market_research",
      "fincept:portfolio_analysis",
      "fincept:risk_report",
    ]));
    expect(finance.tools).toEqual(expect.arrayContaining([
      "Ghostfolio",
      "ghostfolio:launch_sandbox",
      "ghostfolio:portfolio_overview",
      "ghostfolio:holdings_import",
      "ghostfolio:allocation_report",
      "ghostfolio:fire_projection",
    ]));
    expect(finance.approvalRequiredFor).toEqual(expect.arrayContaining([
      "fincept.live_trade",
      "fincept.broker_connect",
      "fincept.real_money_order",
      "ghostfolio.live_sync",
      "ghostfolio.broker_import",
      "ghostfolio.real_account_connect",
    ]));

    expect(growth.tools).not.toContain("Fincept Terminal");
    expect(growth.tools).not.toContain("fincept:launch_sandbox");
    expect(growth.tools).not.toContain("Ghostfolio");
    expect(growth.tools).not.toContain("ghostfolio:launch_sandbox");
  });

  it("injects an outcome snapshot into CEO and analyst runtime prompts", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Outcome Snapshot Co",
      brief: { vision: "Use live operating context" },
      budgetCents: 10000,
    });
    await store.createTask({
      companyId: company.id,
      title: "Fix activation drop-off",
      prompt: "Activation fell yesterday.",
      status: "queued",
      priority: "high",
      agentRole: "analyst",
      tags: [],
    });
    await store.addUsage({
      companyId: company.id,
      category: "llm",
      amountCents: 750,
      description: "Runtime spend",
      metadata: {},
    });

    const ceo = await getAgentRuntime(company.id, "ceo");
    const analyst = await getAgentRuntime(company.id, "analyst");
    const engineer = await getAgentRuntime(company.id, "engineer");

    expect(ceo.dynamicPrompt).toContain("OUTCOME SNAPSHOT");
    expect(ceo.dynamicPrompt).toContain("OPEN TASKS");
    expect(ceo.dynamicPrompt).toContain("Fix activation drop-off");
    expect(ceo.dynamicPrompt).toContain("PROVIDER READINESS");
    expect(analyst.dynamicPrompt).toContain("OUTCOME SNAPSHOT");
    expect(engineer.dynamicPrompt).not.toContain("OUTCOME SNAPSHOT");
  });

  it("loads Finance Ledger skill instructions into the default finance runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Finance Ledger Co",
      brief: { vision: "Guard spend and understand portfolio risk" },
    });

    const environment = buildSlotEnvironment(company.id, "finance");
    const runtime = await getAgentRuntime(company.id, "finance");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "variance-analysis",
      "reconciliation",
      "finance-billing-ops",
      "cfo-advisor",
      "cost-budget-check",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: variance-analysis");
    expect(runtime.staticPrompt).toContain("Skill: reconciliation");
    expect(runtime.staticPrompt).toContain("Skill: finance-billing-ops");
    expect(runtime.staticPrompt).toContain("Skill: cfo-advisor");
    expect(runtime.staticPrompt).toContain("Skill: cost-budget-check");
    expect(runtime.systemPrompt).toContain("Ghostfolio");
  });

  it("loads Design / Content Studio skill instructions into the default content runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Studio Content Co",
      brief: { vision: "Design and write launch material" },
    });

    const environment = buildSlotEnvironment(company.id, "content");
    const runtime = await getAgentRuntime(company.id, "content");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "ui-ux-pro-max",
      "frontend-design",
      "web-artifacts-builder",
      "theme-factory",
      "canvas-design",
      "doc-coauthoring",
      "internal-comms",
      "copywriting",
      "content-creation-and-marketing",
      "frontend-slides",
      "visual-explainer",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: ui-ux-pro-max");
    expect(runtime.staticPrompt).toContain("Skill: frontend-design");
    expect(runtime.staticPrompt).toContain("Skill: copywriting");
    expect(runtime.staticPrompt).toContain("Skill: content-creation-and-marketing");
    expect(runtime.staticPrompt).toContain("Skill: frontend-slides");
    expect(runtime.staticPrompt).toContain("Skill: visual-explainer");
  });

  it("loads Support / Ops Shield skill instructions into the default support runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Support Ops Co",
      brief: { vision: "Keep customer operations moving" },
    });

    const environment = buildSlotEnvironment(company.id, "support");
    const runtime = await getAgentRuntime(company.id, "support");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "customer-escalation",
      "customer-success",
      "incident-runbook-templates",
      "internal-comms",
      "doc-coauthoring",
      "xlsx",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: customer-escalation");
    expect(runtime.staticPrompt).toContain("Skill: customer-success");
    expect(runtime.staticPrompt).toContain("Skill: incident-runbook-templates");
  });

  it("loads Research / Analyst Lens skill instructions into the default analyst runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Research Analyst Co",
      brief: { vision: "Read markets and data clearly" },
    });

    const environment = buildSlotEnvironment(company.id, "analyst");
    const runtime = await getAgentRuntime(company.id, "analyst");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "market-research-analysis",
      "competitive-intelligence-analyst",
      "data-report",
      "xlsx",
      "pdf",
      "docx",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: market-research-analysis");
    expect(runtime.staticPrompt).toContain("Skill: competitive-intelligence-analyst");
    expect(runtime.staticPrompt).toContain("Skill: data-report");
  });

  it("loads Critic / Escalation / Auditor skill instructions into the default escalation runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Audit Critic Co",
      brief: { vision: "Catch risk before action" },
    });

    const environment = buildSlotEnvironment(company.id, "escalation");
    const runtime = await getAgentRuntime(company.id, "escalation");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "risk-assessment",
      "claude-ads-critic",
      "systematic-debugging",
      "receiving-code-review",
      "testing-strategy",
      "verification-before-completion",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: risk-assessment");
    expect(runtime.staticPrompt).toContain("Skill: claude-ads-critic");
    expect(runtime.staticPrompt).toContain("Skill: verification-before-completion");
  });

  it("loads Sales Pipeline skill instructions into the default sales runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Sales Pipeline Co",
      brief: { vision: "Qualify and follow up with the right prospects" },
    });

    const environment = buildSlotEnvironment(company.id, "sales");
    const runtime = await getAgentRuntime(company.id, "sales");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "prospecting",
      "predictable-revenue",
      "gtm-strategy",
      "positioning-messaging",
      "copywriting",
      "email-sequence",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: prospecting");
    expect(runtime.staticPrompt).toContain("Skill: predictable-revenue");
    expect(runtime.staticPrompt).toContain("Skill: positioning-messaging");
  });

  it("grants the Superpowers methodology to the default engineer runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "Superpowers Engineer Co",
      brief: { vision: "Build with disciplined engineering loops" },
    });

    const environment = buildSlotEnvironment(company.id, "engineer");
    const runtime = await getAgentRuntime(company.id, "engineer");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "using-superpowers",
      "brainstorming",
      "using-git-worktrees",
      "writing-plans",
      "test-driven-development",
      "subagent-driven-development",
      "requesting-code-review",
      "verification-before-completion",
      "finishing-a-development-branch",
      "gh-cli",
      "make-repo-contribution",
      "prd",
      "system-design",
      "testing-strategy",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: using-superpowers");
    expect(runtime.staticPrompt).toContain("Skill: test-driven-development");
    expect(runtime.staticPrompt).toContain("Skill: gh-cli");
    expect(runtime.staticPrompt).toContain("Skill: make-repo-contribution");
    expect(runtime.staticPrompt).toContain("Skill: prd");
    expect(runtime.staticPrompt).toContain("Skill: system-design");
    expect(runtime.staticPrompt).toContain("Skill: testing-strategy");
    expect(runtime.dynamicPrompt).toContain("Granted skills: using-superpowers");
  });

  it("grants operating strategy skills to the default CEO runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "CEO Strategy Co",
      brief: { vision: "Run a disciplined operating cadence" },
    });

    const environment = buildSlotEnvironment(company.id, "ceo");
    const runtime = await getAgentRuntime(company.id, "ceo");

    expect(environment.skills).toEqual(expect.arrayContaining([
      "gtm-operating-cadence",
      "gtm-board-and-investor-communication",
      "setting-okrs-goals",
    ]));
    expect(runtime.staticPrompt).toContain("Skill: gtm-operating-cadence");
    expect(runtime.staticPrompt).toContain("Skill: gtm-board-and-investor-communication");
    expect(runtime.staticPrompt).toContain("Skill: setting-okrs-goals");
    expect(runtime.dynamicPrompt).toContain("Granted skills: gtm-operating-cadence");
  });

  it("loads HyperFrames skill instructions into the default growth runtime", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: "HyperFrames Growth Co",
      brief: { vision: "Create launch videos" },
    });

    const runtime = await getAgentRuntime(company.id, "growth");

    expect(runtime.staticPrompt).toContain("Skill: hyperframes");
    expect(runtime.staticPrompt).toContain("Skill: hyperframes-cli");
    expect(runtime.staticPrompt).toContain("Skill: gtm-product-led-growth");
    expect(runtime.staticPrompt).toContain("Skill: positioning-messaging");
    expect(runtime.staticPrompt).toContain("Skill: ads");
    expect(runtime.staticPrompt).toContain("Skill: email-sequence");
    expect(runtime.staticPrompt).toContain("Skill: gtm-strategy");
    expect(runtime.systemPrompt).toContain("HyperFrames");
  });

  it("persists a plugged profile separately from agent description text", async () => {
    const company = await store.createCompany({
      name: "Agent Plug Runtime Co",
      brief: { vision: "Customize operating slots safely" }
    });
    const profile = AGENT_CATALOG.find((agent) => agent.id === "eng-backend-architect");
    expect(profile).toBeDefined();

    const assignment = await store.upsertAgentPlugAssignment({
      companyId: company.id,
      role: "engineer",
      profileId: profile!.id
    });
    const runtime = await getAgentRuntime(company.id, "engineer");

    expect(assignment.profileId).toBe(profile!.id);
    expect(assignment.environment.skills).toEqual(profile!.skills);
    expect(runtime.profile?.name).toBe(profile!.name);
    expect(runtime.systemPrompt).toContain("Slot mission:");
    expect(runtime.systemPrompt).toContain("Allowed tools:");
    expect(runtime.systemPrompt).toContain("Granted skills:");
    expect(runtime.systemPrompt).toContain("Skill: verification-before-completion");
    expect(runtime.systemPrompt).toContain(profile!.specialties);
  });
});
