import type { AppState, CompanyBrief } from "@/lib/types";
import { createDefaultAgents } from "@/lib/agents";
import { makeId, nowIso } from "@/lib/utils";
import { db } from "@/lib/db";

const companyId = "company_trent_demo";
const createdAt = nowIso();

const brief: CompanyBrief = {
  vision: "Build an AI cofounder that helps solo founders operate a software company from idea to revenue.",
  icp: "Solo founders, non-technical operators, and small teams who want strategy, product, growth, and support execution in one place.",
  offer: "A company mission-control app with autonomous agents, task execution, approvals, reports, and integrations.",
  pricing: "$49/month starter plan with usage credits; revenue-share ready once Stripe Connect is enabled.",
  competitors: "a competing product, Devin, Lovable, a competing platform Agent, Taskade, n8n, custom Claude Code workflows.",
  brandVoice: "Direct, capable, calm, operator-grade, slightly playful when it helps the founder feel momentum.",
  goals: "Prove the core autonomy loop: create a company, run an agent cycle, produce tasks, route approvals, and track costs.",
  constraints: "Mock dangerous external actions until credentials, spend caps, and approval policies are production-ready.",
  successMetrics: "Cycle completion rate, approved tasks, shipped code tasks, created reports, cost per completed task, founder trust."
};

export function createSeedState(): AppState {
  const agents = createDefaultAgents(companyId);
  return {
    companies: [
      {
        id: companyId,
        name: "Trent Demo Company",
        slug: "trent-demo",
        website: "https://trent.local",
        status: "active",
        autonomyLevel: "autonomous_with_approvals",
        publicVisibility: true,
        publicSubdomain: "trent-demo.trent.local",
        timezone: "America/Toronto",
        budgetCents: 15000,
        cycleFrequency: "daily",
        nextCycleAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt,
        updatedAt: createdAt,
        brief,
        metrics: {
          users: 128,
          signups: 36,
          revenueCents: 0,
          conversionRate: 0.12,
          retentionRate: 0.68
        }
      }
    ],
    agents,
    tasks: [
      {
        id: makeId("task"),
        companyId,
        title: "Define the approval policy for risky external actions",
        prompt: "List all actions that must require human approval before execution.",
        status: "waiting_approval",
        priority: "high",
        agentRole: "escalation",
        tags: ["safety", "approvals"],
        costCents: 42,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: makeId("task"),
        companyId,
        title: "Draft first growth experiments for the AI cofounder audience",
        prompt: "Create a focused acquisition backlog for founder communities and build-in-public channels.",
        status: "queued",
        priority: "medium",
        agentRole: "growth",
        tags: ["growth", "marketing"],
        costCents: 38,
        createdAt,
        updatedAt: createdAt
      }
    ],
    recurringTasks: [
      {
        id: makeId("recurring"),
        companyId,
        title: "Daily growth and customer signal sweep",
        prompt: "Review metrics, support themes, public mentions, and campaign opportunities. Create follow-up tasks, but do not send or publish externally.",
        agentRole: "growth",
        priority: "medium",
        tags: ["growth", "daily-cycle"],
        cadence: "daily",
        enabled: true,
        nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt
      },
      {
        id: makeId("recurring"),
        companyId,
        title: "Weekly operating report",
        prompt: "Summarize cycles, tasks, approvals, costs, product progress, growth learnings, and recommended next actions.",
        agentRole: "analyst",
        priority: "high",
        tags: ["weekly-report", "analytics"],
        cadence: "weekly",
        enabled: true,
        nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt
      }
    ],
    cycles: [],
    executions: [],
    approvals: [
      {
        id: "approval_initial_policy",
        companyId,
        action: "Enable autonomous-with-approvals operating mode",
        reason: "Trent should run daily work but stop before public, financial, destructive, or irreversible actions.",
        status: "pending",
        createdAt
      }
    ],
    documents: [
      {
        id: makeId("doc"),
        companyId,
        type: "brief",
        title: "Company Operating Brief",
        content: Object.entries(brief)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n\n"),
        source: "onboarding",
        version: 1,
        createdAt
      },
      {
        id: makeId("doc"),
        companyId,
        type: "feature_gap",
        title: "a competing product Feature Coverage Delta",
        content:
          "Public a competing product research indicates daily agent cycles, public dashboards/subdomains, GitHub, email, ads, billing, social scheduling, media generation, browser automation, screenshots, hosted apps, managed databases, object storage, error monitoring, and attribution. Trent currently implements the safe operating loop and marks high-risk providers as needing credentials until approvals, budgets, and real provider access are wired.",
        source: "public-research",
        version: 1,
        createdAt
      }
    ],
    artifacts: [],
    workbenchSessions: [],
    workbenchEvents: [],
    workbenchArtifacts: [],
    workbenchChatMessages: [],
    workbenchAttempts: [],
    workbenchCheckpoints: [],
    orchestratorRuns: [],
    orchestratorSteps: [],
    orchestratorEvents: [],
    contentMissionRuns: [],
    contentMissionActions: [],
    agentMissionRuns: [],
    agentMissionSteps: [],
    agentMissionEvents: [],
    reports: [],
    usage: [
      {
        id: makeId("usage"),
        companyId,
        category: "llm",
        description: "Seeded planning estimate",
        amountCents: 42,
        metadata: { model: "local-fallback", task: "approval-policy" },
        createdAt
      }
    ],
    integrations: [
      {
        id: makeId("integration"),
        companyId,
        provider: "GitHub",
        scopes: ["repo:read", "issues:write", "pull_requests:write"],
        status: process.env.GITHUB_TOKEN ? "connected" : "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Email",
        scopes: ["draft", "send_requires_approval"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Postmark",
        scopes: ["transactional_email", "inbound_email"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Hunter.io",
        scopes: ["email_verification", "deliverability"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Meta Ads",
        scopes: ["draft_campaign", "launch_requires_approval"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Meta Pixel/CAPI",
        scopes: ["conversion_events", "attribution"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Stripe",
        scopes: ["subscriptions", "connect_ready"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Cloudflare R2",
        scopes: ["asset_storage", "generated_media"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Anthropic",
        scopes: ["llm_primary", "model_telemetry"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "AWS Bedrock",
        scopes: ["llm_fallback", "model_routing"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Fal.ai",
        scopes: ["image_generation", "video_generation", "audio_generation"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Late.dev",
        scopes: ["social_schedule", "multi_platform_posting"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Browserbase",
        scopes: ["cloud_browser", "screenshots", "extraction"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Steel Browser",
        scopes: ["steel:scrape", "steel:screenshot", "steel:pdf", "steel:sessions"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "HyperFrames",
        scopes: ["hyperframes:create", "hyperframes:preview", "hyperframes:lint", "hyperframes:render"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Open Generative AI",
        scopes: ["open_gen_ai:launch_sandbox", "open_gen_ai:image_generate", "open_gen_ai:video_generate", "open_gen_ai:asset_export"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Claude Ads",
        scopes: ["claude_ads:audit", "claude_ads:creative_review", "claude_ads:budget_review", "claude_ads:report"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      },
      {
        id: makeId("integration"),
        companyId,
        provider: "Sentry",
        scopes: ["error_monitoring", "diagnostics"],
        status: "needs_credentials",
        lastCheckedAt: createdAt
      }
    ],
    auditLogs: [],
    jobRuns: [],
    agentPlugAssignments: [],
    agentEntitlements: [],
    ceoMessages: [
      {
        id: "ceomsg_welcome",
        companyId,
        direction: "from_ceo",
        kind: "briefing",
        content: "Good to have you here. I've reviewed the company brief and I'm ready to run. Kick off a cycle when you're ready and I'll coordinate the agents, surface what needs your approval, and report back here.",
        createdAt
      }
    ],
    ceoSuggestions: [],
    comments: [],
    marketingAccounts: [],
    conversionEvents: [],
    adCampaigns: [],
    adCreativeVariants: [],
    audienceSegments: [],
    adSpendCharges: [],
    optimizationRuns: [],
    creativePerformanceMemories: [],
    invoices: [],
    ledgerEntries: [],
    payoutHolds: [],
    stripeCustomers: [],
    stripeSubscriptions: [],
    stripeWebhookEvents: []
  };
}

export async function seedDatabase() {
  const count = await db.company.count();
  if (count > 0) return;

  const state = createSeedState();

  const defaultUser = await db.user.upsert({
    where: { email: "founder@trent.local" },
    update: {},
    create: {
      id: "user_founder_trent_local",
      email: "founder@trent.local",
      name: "founder"
    }
  });

  const company = state.companies[0];
  await db.company.create({
    data: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      website: company.website ?? null,
      status: company.status,
      autonomyLevel: company.autonomyLevel,
      publicVisibility: company.publicVisibility,
      publicSubdomain: company.publicSubdomain,
      timezone: company.timezone,
      budgetCents: company.budgetCents,
      cycleFrequency: company.cycleFrequency,
      lastCycleAt: company.lastCycleAt ? new Date(company.lastCycleAt) : null,
      nextCycleAt: company.nextCycleAt ? new Date(company.nextCycleAt) : null,
      brief: company.brief,
      metrics: company.metrics,
      createdAt: new Date(company.createdAt),
      updatedAt: new Date(company.updatedAt)
    }
  });

  await db.companyMember.create({
    data: {
      id: `member_${defaultUser.id}_${company.id}`,
      companyId: company.id,
      userId: defaultUser.id,
      role: "owner",
      permissions: ["*"]
    }
  });

  await db.agent.createMany({
    data: state.agents.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      role: agent.role,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      modelPolicy: agent.modelPolicy,
      permissions: agent.permissions
    }))
  });

  await db.task.createMany({
    data: state.tasks.map((task) => ({
      id: task.id,
      companyId: task.companyId,
      title: task.title,
      prompt: task.prompt,
      status: task.status,
      priority: task.priority,
      agentRole: task.agentRole,
      tags: task.tags,
      dueDate: task.dueDate ? new Date(task.dueDate) : null,
      approvalId: task.approvalId ?? null,
      recurringTemplateId: task.recurringTemplateId ?? null,
      costCents: task.costCents,
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt)
    }))
  });

  await db.recurringTaskTemplate.createMany({
    data: state.recurringTasks.map((template) => ({
      id: template.id,
      companyId: template.companyId,
      title: template.title,
      prompt: template.prompt,
      agentRole: template.agentRole,
      priority: template.priority,
      tags: template.tags,
      cadence: template.cadence,
      enabled: template.enabled,
      lastMaterializedAt: template.lastMaterializedAt ? new Date(template.lastMaterializedAt) : null,
      nextRunAt: new Date(template.nextRunAt),
      createdAt: new Date(template.createdAt)
    }))
  });

  await db.approval.createMany({
    data: state.approvals.map((approval) => ({
      id: approval.id,
      companyId: approval.companyId,
      taskId: approval.taskId ?? null,
      action: approval.action,
      reason: approval.reason,
      status: approval.status,
      createdAt: new Date(approval.createdAt),
      resolvedAt: approval.resolvedAt ? new Date(approval.resolvedAt) : null
    }))
  });

  await db.document.createMany({
    data: state.documents.map((doc) => ({
      id: doc.id,
      companyId: doc.companyId,
      type: doc.type,
      title: doc.title,
      content: doc.content,
      source: doc.source,
      version: doc.version,
      createdAt: new Date(doc.createdAt)
    }))
  });

  await db.usageLedgerEntry.createMany({
    data: state.usage.map((entry) => ({
      id: entry.id,
      companyId: entry.companyId,
      category: entry.category,
      description: entry.description,
      amountCents: entry.amountCents,
      metadata: entry.metadata,
      createdAt: new Date(entry.createdAt)
    }))
  });

  await db.toolConnection.createMany({
    data: state.integrations.map((integration) => ({
      id: integration.id,
      companyId: integration.companyId,
      provider: integration.provider,
      scopes: integration.scopes,
      status: integration.status,
      encryptedData: integration.encryptedData ?? null,
      lastCheckedAt: new Date(integration.lastCheckedAt)
    }))
  });

  await db.ceoMessage.createMany({
    data: state.ceoMessages.map((msg) => ({
      id: msg.id,
      companyId: msg.companyId,
      direction: msg.direction,
      kind: msg.kind,
      content: msg.content,
      createdAt: new Date(msg.createdAt)
    }))
  });

  await db.ceoSuggestion.createMany({
    data: state.ceoSuggestions.map((sug) => ({
      id: sug.id,
      companyId: sug.companyId,
      title: sug.title,
      body: sug.body,
      category: sug.category,
      status: sug.status,
      createdAt: new Date(sug.createdAt)
    }))
  });
}
