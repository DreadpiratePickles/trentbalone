import OpenAI from "openai";
import { z } from "zod";
import { getAgentRuntime } from "@/lib/agent-runtime";
import {
  buildAgentRoutingContext,
  formatRouteRecommendation,
  recommendSeatForObjective,
} from "@/lib/agent-routing-context";
import { inferArtifactRequest } from "@/lib/artifacts";
import type { AgentRole, CeoArtifactRequest, CeoMessage, CeoSuggestion, Company, Cycle, Document, Report, Task } from "@/lib/types";
import { MODELS, MAX_TOKENS, createAIClient } from "@/lib/ai-client";
import { callJsonWithRepair } from "@/lib/llm-json";
import { buildOperatingStateBundle } from "@/lib/operating-state";
import {
  agentRoles,
  normalizePlannerAgentRole,
  normalizePlannerBoolean,
  normalizePlannerStringList,
} from "@/lib/orchestrator-runtime";

const planSchema = z.object({
  summary: z.string(),
  tasks: z.array(
    z.object({
      title: z.string(),
      prompt: z.string(),
      agentRole: z.enum(["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"]),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      tags: z.array(z.string())
    })
  ),
  approvals: z.array(
    z.object({
      action: z.string(),
      reason: z.string(),
      toolName: z.string().optional(),
      previewContent: z.string().optional(),
      previewKind: z.enum(["email", "post", "diff", "contract", "generic"]).optional()
    })
  ),
  reportFindings: z.array(z.string()),
  reportRecommendations: z.array(z.string())
});

export type GeneratedPlan = z.infer<typeof planSchema>;

async function withRetries<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

export async function generateOperatingPlan(company: Company): Promise<{ plan: GeneratedPlan; model: string; tokens: number; costCents: number; degraded: boolean }> {
  const model = MODELS.STRONG;
  const fallback = deterministicPlan(company);

  if (!process.env.OPENAI_API_KEY) {
    return { plan: fallback, model: "local-fallback", tokens: 0, costCents: 0, degraded: true };
  }

  // §1 P0-2 — real state inspection: plan from a compact operating-state bundle
  // (open/stale tasks, last cycle, pending approvals, budget, recalled memory)
  // instead of the context-starved JSON.stringify(company).
  const objective = company.brief?.goals || `Operate ${company.name} toward its vision`;
  const bundle = await buildOperatingStateBundle(company, objective).catch(() => null);

  try {
    const ceoRuntime = await getAgentRuntime(company.id, "ceo");
    const system = ceoRuntime.systemPrompt;
    const user = [
      "Create one operating-cycle plan as JSON matching this shape: summary, tasks[], approvals[], reportFindings[], reportRecommendations[].",
      "Each approval may include optional previewContent (the actual draft text being approved) and previewKind (\"email\"|\"post\"|\"diff\"|\"contract\"|\"generic\").",
      "Plan against the CURRENT operating state below — adopt or progress open tasks before minting new ones, respect pending approvals, and stay within remaining budget.",
      "",
      "COMPANY BRIEF:",
      JSON.stringify(company.brief ?? {}),
      "",
      "OPERATING STATE:",
      bundle?.text ?? "(state unavailable)",
    ].join("\n");

    // §1 P0-3 — no silent fallback: repair-retry, then surface a degraded plan.
    const { data, tokens, repaired } = await callJsonWithRepair<GeneratedPlan>({
      model,
      system,
      user,
      schema: planSchema,
      maxTokens: MAX_TOKENS.PLANNING,
    });
    return { plan: data, model, tokens, costCents: estimateCostCents(tokens), degraded: repaired };
  } catch (err) {
    console.error("generateOperatingPlan: planner failed after repair retry", err instanceof Error ? err.message : err);
    return { plan: fallback, model: "local-fallback-after-error", tokens: 0, costCents: 0, degraded: true };
  }
}

export function summarizeAgentWork(role: AgentRole, company: Company) {
  const summaries: Record<AgentRole, string> = {
    ceo: `Prioritized ${company.name}'s next operating loop around ${company.brief.goals || "validating the company thesis"}.`,
    engineer: "Prepared a safe GitHub issue/PR path and held merge actions behind approval.",
    growth: "Drafted channel experiments and campaign ideas without sending messages or launching ads.",
    content: "Outlined founder-facing copy and launch content from the operating brief.",
    support: "Prepared support triage notes and marked sensitive replies for approval; no live inbox is configured.",
    finance: "Checked budget caps and logged model usage to the cost ledger.",
    analyst: "Reviewed research targets, funnel, signup, revenue, retention, and cost signals for the next report.",
    escalation: "Confirmed human approval is required for public, financial, destructive, email, ad, code-merge, billing, and domain actions.",
    sales: "Drafted prospect research and sales follow-up plans without sending outbound messages."
  };
  return summaries[role];
}

export async function executeAgentRole(
  role: AgentRole,
  company: Company,
  tasks: Task[],
  systemPrompt: string
): Promise<{ output: string; model: string; tokens: number; costCents: number }> {
  const fallbackText = summarizeAgentWork(role, company);
  if (!process.env.OPENAI_API_KEY) {
    return { output: fallbackText, model: "local-fallback", tokens: 0, costCents: 0 };
  }

  const model = MODELS.DEFAULT;

  try {
    const tasksBlock = tasks.length > 0
      ? tasks.map(t => `- [${t.status}] ${t.title}: ${t.prompt} (${t.priority} priority)`).join("\n")
      : "No tasks assigned currently.";

    const userPrompt = [
      `You are running the execution phase for your role: ${role}.`,
      "",
      `Company Brief:`,
      JSON.stringify(company.brief, null, 2),
      "",
      `Current Tasks:`,
      tasksBlock,
      "",
      `Perform your role's work based on the brief, mission contract, and tasks. Write a concise, detailed, professional update on what you did, the results of your actions, any findings, and recommended next steps for your slot. Do not include markdown code block formatting or JSON around the response, just output the plain text response.`
    ].join("\n");

    const completion = await withRetries(() =>
      createAIClient().chat.completions.create({
        model,
        temperature: 0.5,
        max_tokens: MAX_TOKENS.PROSE,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    );

    const output = completion.choices[0]?.message.content ?? fallbackText;
    const tokens = completion.usage?.total_tokens ?? 0;
    return { output, model, tokens, costCents: estimateCostCents(tokens) };
  } catch (error) {
    console.error(`executeAgentRole(${role}): LLM call failed`, error instanceof Error ? error.message : error);
    return { output: fallbackText, model: "local-fallback-after-error", tokens: 0, costCents: 0 };
  }
}


function estimateCostCents(tokens: number) {
  return Math.max(1, Math.ceil(tokens * 0.002));
}

// ── CEO Chat ─────────────────────────────────────────────────────────────────

const ceoRoleSchema = z.preprocess(normalizePlannerAgentRole, z.enum(agentRoles));
const ceoStringListSchema = z.preprocess(normalizePlannerStringList, z.array(z.string()));
const ceoBooleanSchema = z.preprocess(normalizePlannerBoolean, z.boolean());
const ceoOptionalStringSchema = z.preprocess(
  (value) => value == null ? undefined : value,
  z.string().optional(),
);
const ceoPrioritySchema = z.preprocess(
  (value) => typeof value === "string" ? value.toLowerCase().trim() : value,
  z.enum(["low", "medium", "high", "urgent"]),
);
const ceoSuggestionCategorySchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (/\b(outreach|email|dm|sales|prospect|lead)\b/.test(normalized)) return "outreach";
  if (/\b(content|copy|post|blog|creative)\b/.test(normalized)) return "content";
  if (/\b(product|feature|roadmap|bug)\b/.test(normalized)) return "product";
  if (/\b(finance|budget|spend|cash|revenue)\b/.test(normalized)) return "finance";
  if (/\b(action|task|todo|approval|operation|ops|next step|follow up)\b/.test(normalized)) return "operations";
  return "other";
}, z.enum(["outreach", "content", "product", "operations", "finance", "other"]));

const ceoResponseSchema = z.object({
  message: z.string(),
  // What Trent understood — shown before acting
  understood: z.object({
    intent: ceoOptionalStringSchema,
    routedTo: ceoOptionalStringSchema,
    willDo: ceoOptionalStringSchema,
    approvalRequired: ceoBooleanSchema.optional(),
  }).optional(),
  // Tasks to create on behalf of the founder
  createTasks: z.array(z.object({
    title: z.string(),
    prompt: z.string(),
    agentRole: ceoRoleSchema,
    priority: ceoPrioritySchema,
    tags: ceoStringListSchema.default([]),
  })).optional().default([]),
  createArtifacts: z.array(z.object({
    title: z.string(),
    prompt: z.string(),
    type: z.enum(["board_pdf", "xlsx_report", "dashboard", "investor_update", "campaign_report", "competitive_research", "operating_memo", "support_summary"]),
    createdByAgent: ceoRoleSchema,
    exportFormat: z.enum(["markdown", "html", "pdf", "csv", "xlsx", "dashboard_json"]).optional()
  })).optional().default([]),
  suggestions: z.array(z.object({
    title: z.string(),
    body: z.string(),
    category: ceoSuggestionCategorySchema
  })).optional().default([])
});

export type CeoResponse = z.infer<typeof ceoResponseSchema>;

export async function ceoChatResponse(
  company: Company,
  history: CeoMessage[],
  ownerMessage: string,
  context: { tasks: Task[]; lastCycle?: Cycle; documents?: Document[]; reports?: Report[] }
): Promise<CeoResponse> {
  const fallback = ceoChatFallback(company, ownerMessage, context);

  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const ceoRuntime = await getAgentRuntime(company.id, "ceo");
    const systemPrompt = buildCeoChatSystemPrompt({
      company,
      ceoRuntimeSystemPrompt: ceoRuntime.systemPrompt,
      ownerMessage,
      context,
    });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      // inject recent history (last 10 turns)
      ...history.slice(-10).map((m): OpenAI.ChatCompletionMessageParam => ({
        role: m.direction === "from_owner" ? "user" : "assistant",
        content: m.content
      })),
      { role: "user", content: ownerMessage }
    ];

    const completion = await withRetries(() =>
      createAIClient().chat.completions.create({
        model: MODELS.DEFAULT,
        temperature: 0.4,
        max_tokens: MAX_TOKENS.CHAT,
        response_format: { type: "json_object" },
        messages
      })
    );

    const text = completion.choices[0]?.message.content ?? "{}";
    const parsed = ceoResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.error("ceoChatResponse: schema parse failed", parsed.error.issues.map(i => i.message));
    }
    return parsed.success ? parsed.data : fallback;
  } catch (err) {
    console.error("ceoChatResponse: LLM call failed", err instanceof Error ? err.message : err);
    return fallback;
  }
}

export function buildCeoChatSystemPrompt(input: {
  company: Company;
  ceoRuntimeSystemPrompt: string;
  ownerMessage: string;
  context: { tasks: Task[]; lastCycle?: Cycle; documents?: Document[]; reports?: Report[] };
}): string {
  const route = recommendSeatForObjective(input.ownerMessage);
  const runningTasks = input.context.tasks.filter(t => t.status === "running" || t.status === "queued").length;
  const pendingApprovals = input.context.tasks.filter(t => t.status === "waiting_approval").length;

  return [
    input.ceoRuntimeSystemPrompt,
    "",
    "You are the CEO of the AI operating company. The human founder is talking to you directly.",
    "Your job: understand what the founder is asking, route work to the correct agent, and confirm what you understood before acting.",
    buildAgentRoutingContext(input.company.id),
    formatRouteRecommendation("owner message", route),
    "If the founder's message contains work that should be done by an agent, include it in createTasks[].",
    "If the founder asks for a PDF, spreadsheet, dashboard, report, investor update, campaign report, competitive research, operating memo, or support summary, include it in createArtifacts[].",
    "Always include the 'understood' object showing: intent (what you understood), routedTo (which agent if any), willDo (brief summary of action), approvalRequired (true if external side effects).",
    "When you identify things the human needs to do personally (calls, external decisions, approvals), include them in suggestions[].",
    "Keep your message concise — 2-4 sentences max unless the owner asks for detail.",
    `Respond as JSON: { message: string, understood: {intent, routedTo, willDo, approvalRequired}, createTasks: [{title, prompt, agentRole, priority, tags}], createArtifacts: [{title, prompt, type, createdByAgent, exportFormat}], suggestions: [{title, body, category}] }`,
    "",
    `Company: ${input.company.name} · Brief: ${input.company.brief.vision?.slice(0, 120) ?? "not set"}`,
    `Company memory: ${compactCompanyKnowledge(input.context.documents ?? [], input.context.reports ?? [])}`,
    `Active tasks: ${runningTasks}`,
    `Pending approvals: ${pendingApprovals}`,
    `Last cycle: ${input.context.lastCycle?.summary ?? "No cycles run yet"}`,
  ].join("\n");
}

export async function generalChatResponse(
  history: CeoMessage[],
  ownerMessage: string
): Promise<CeoResponse> {
  const fallback: CeoResponse = {
    message: "I can answer general questions when the model gateway is configured. OpenAI is not configured for this environment right now.",
    understood: {
      intent: "General chatbot request",
      routedTo: "general",
      willDo: "Answer without creating company tasks or artifacts.",
      approvalRequired: false,
    },
    createTasks: [],
    createArtifacts: [],
    suggestions: [],
  };

  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          "You are Trent's general chat mode, a direct general-purpose LLM assistant.",
          "Answer broad questions about science, politics, code, writing, strategy, math, and everyday topics.",
          "Do not create company tasks, artifacts, approvals, or external side effects.",
          "If the user asks for live or very recent facts such as current weather, breaking news, prices, or schedules, be clear that you do not have live browsing/tools in this chat unless that data is provided.",
          "Be concise by default, but give enough detail to be useful."
        ].join("\n")
      },
      ...history.slice(-10).map((m): OpenAI.ChatCompletionMessageParam => ({
        role: m.direction === "from_owner" ? "user" : "assistant",
        content: m.content
      })),
      { role: "user", content: ownerMessage }
    ];

    const completion = await withRetries(() =>
      createAIClient().chat.completions.create({
        model: MODELS.DEFAULT,
        temperature: 0.5,
        max_tokens: MAX_TOKENS.CHAT,
        messages
      })
    );

    return {
      message: completion.choices[0]?.message.content?.trim() || fallback.message,
      understood: {
        intent: "General chatbot request",
        routedTo: "general",
        willDo: "Answered directly through the general LLM bridge.",
        approvalRequired: false,
      },
      createTasks: [],
      createArtifacts: [],
      suggestions: [],
    };
  } catch {
    return fallback;
  }
}

function compactCompanyKnowledge(documents: Document[], reports: Report[]) {
  const documentLines = documents.slice(0, 8).map((doc) =>
    `Document ${doc.title} (${doc.type}/${doc.memoryTier ?? "working"}): ${doc.content.slice(0, 700)}`
  );
  const reportLines = reports.slice(0, 4).map((report) =>
    `Report ${report.title} (${report.type}): findings=${report.findings.slice(0, 3).join("; ")} recommendations=${report.recommendations.slice(0, 3).join("; ")}`
  );
  const lines = [...documentLines, ...reportLines];
  return lines.length ? lines.join("\n") : "No uploaded memory or reports yet.";
}

function ceoChatFallback(
  company: Company,
  ownerMessage: string,
  context: { tasks: Task[]; lastCycle?: Cycle }
): CeoResponse {
  const running = context.tasks.filter(t => t.status === "running" || t.status === "queued").length;
  const pending = context.tasks.filter(t => t.status === "waiting_approval").length;
  const route = recommendSeatForObjective(ownerMessage);

  const lower = ownerMessage.toLowerCase();
  let message = "";

  if (lower.includes("status") || lower.includes("what") || lower.includes("update") || lower.includes("how")) {
    message = `${company.name} has ${running} task${running !== 1 ? "s" : ""} queued or running. ${pending > 0 ? `${pending} item${pending !== 1 ? "s" : ""} need your approval before I can proceed.` : "No approvals pending — we're clear to run."} ${context.lastCycle ? `Last cycle: ${context.lastCycle.summary}` : "Run your first cycle to get started."}`;
  } else if (lower.includes("priorit") || lower.includes("focus")) {
    message = `Right now I'm prioritizing ${company.brief.goals || "validating the company thesis"}. I'll route engineering and growth tasks through the approval gates before any external actions.`;
  } else if (lower.includes("help") || lower.includes("suggest") || lower.includes("idea")) {
    message = `Based on ${company.name}'s ICP and offer, I'd recommend we tighten the brief this week and get one growth experiment approved. I've listed a couple of things you can do on your end that would unblock us.`;
  } else {
    message = `Understood. I'm managing the ${company.name} operating cycle — all risky actions are gated for your approval. Let me know if you want me to shift priorities or give you a full status rundown.`;
  }

  const suggestions: CeoResponse["suggestions"] = [];

  if (pending > 0) {
    suggestions.push({
      title: `Review ${pending} pending approval${pending !== 1 ? "s" : ""}`,
      body: "I can't proceed on gated actions until you approve or reject them. Head to the Approvals page.",
      category: "operations"
    });
  }

  if (!company.brief.goals || company.brief.goals.length < 20) {
    suggestions.push({
      title: "Sharpen the company brief",
      body: "The goals section is too vague for me to generate high-quality tasks. Spend 5 minutes updating it in Settings.",
      category: "product"
    });
  }

  const artifact = inferArtifactRequest(ownerMessage);
  const createArtifacts: CeoArtifactRequest[] = artifact ? [artifact] : [];

  return {
    message,
    understood: {
      intent: ownerMessage.slice(0, 180),
      routedTo: route.role,
      willDo: `Route through ${route.role} using ${route.tool} when applicable.`,
      approvalRequired: /\b(send|publish|launch|spend|charge|refund|merge|deploy|delete|trade|broker|external)\b/i.test(ownerMessage),
    },
    suggestions,
    createTasks: [],
    createArtifacts,
  };
}

function deterministicPlan(company: Company): GeneratedPlan {
  return {
    summary: `${company.name} is ready for a safe autonomy pass: sharpen the brief, create an engineering execution path, and draft growth work while approvals protect risky actions.`,
    tasks: [
      {
        title: "Refresh the company operating brief into a one-week roadmap",
        prompt: "Convert the current vision, ICP, offer, constraints, and success metrics into a concise one-week roadmap.",
        agentRole: "ceo",
        priority: "high",
        tags: ["strategy", "roadmap"]
      },
      {
        title: "Create a GitHub implementation issue for the next product slice",
        prompt: "Draft a GitHub issue and PR plan for the highest leverage product workflow. Do not merge code without approval.",
        agentRole: "engineer",
        priority: "high",
        tags: ["github", "engineering"]
      },
      {
        title: "Draft three growth experiments for the ICP",
        prompt: "Create testable acquisition experiments with channel, audience, message, expected signal, and approval needs.",
        agentRole: "growth",
        priority: "medium",
        tags: ["growth", "experiments"]
      },
      {
        title: "Write a weekly founder report",
        prompt: "Summarize progress, risks, cost, and recommended next actions with clear assumptions.",
        agentRole: "analyst",
        priority: "medium",
        tags: ["report", "analytics"]
      }
    ],
    approvals: [
      {
        action: "Authorize GitHub issue creation for the next product slice",
        reason: "Creating issues is low risk but still touches an external integration when GitHub credentials are connected.",
        toolName: "GitHub"
      },
      {
        action: "Approve any outbound email, ad launch, public post, charge, domain change, data deletion, or code merge",
        reason: "Trent defaults to autonomous-with-approvals and must pause before public, financial, destructive, or irreversible actions."
      }
    ],
    reportFindings: [
      "The company has a complete enough brief to generate operating tasks.",
      "External execution is intentionally constrained by approval gates.",
      "GitHub can become the first real tool path while email, ads, billing, social, browser, and deploys stay not configured until real credentials and approvals are in place."
    ],
    reportRecommendations: [
      "Run one daily cycle and review approvals each morning.",
      "Connect GitHub first, then add email draft approval once task quality is reliable.",
      "Track cost per completed task before enabling broader autonomy."
    ]
  };
}
