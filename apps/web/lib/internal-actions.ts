import { store as defaultStore } from "@/lib/store";
import type { AgentRole, Document, ToolCallRecord } from "@/lib/types";

type InternalStore = Pick<
  typeof defaultStore,
  | "createApproval"
  | "createDocument"
  | "createReport"
  | "createTask"
  | "getCompany"
  | "listApprovals"
  | "listDocuments"
  | "listReports"
  | "listTasks"
  | "listUsage"
  | "updateCompany"
  | "addAudit"
>;

export type InternalActionContext = {
  companyId: string;
  actor?: AgentRole | "system";
  payload?: Record<string, unknown>;
  store?: InternalStore;
};

type InternalActionHandler = (action: string, ctx: Required<Pick<InternalActionContext, "companyId" | "payload" | "store">> & {
  actor: AgentRole | "system";
}) => Promise<ToolCallRecord>;

export type InternalActionCapability = {
  writeCapable: boolean;
  approvalRequired: boolean;
};

const HANDLERS = {
  "memory:read": readMemory,
  "tasks:create": createTask,
  "tasks:block": blockTask,
  "reports:create": createReport,
  "documents:write": writeDocument,
  "approvals:create": requestApproval,
  "approvals:request": requestApproval,
  "audit:create": createAudit,
  "usage:read": readUsage,
  "billing:read": readBilling,
  "goals:read": readGoals,
  "goals:update": updateGoalsDraft,
  "support:inbound_email": readInboundSupportEmail,
  "email:draft": draftEmail,
  "social:draft": draftSocial,
  "ads:draft": draftAdPlan,
  "crm:update_draft": draftCrmUpdate,
  "prospects:research": researchProspects,
} satisfies Record<string, InternalActionHandler>;

const READ_ACTIONS = new Set([
  "memory:read",
  "usage:read",
  "billing:read",
  "goals:read",
  "support:inbound_email",
]);

export const INTERNAL_ACTIONS: ReadonlySet<string> = new Set(Object.keys(HANDLERS));

export function internalActionCapability(tool: string): InternalActionCapability | undefined {
  if (!INTERNAL_ACTIONS.has(tool)) return undefined;
  const writeCapable = !READ_ACTIONS.has(tool);
  return {
    writeCapable,
    approvalRequired: writeCapable,
  };
}

export async function runInternalAction(
  tool: string,
  action: string,
  ctx: InternalActionContext,
): Promise<ToolCallRecord> {
  const handler = HANDLERS[tool as keyof typeof HANDLERS];
  if (!handler) {
    return failed(tool, action, `Internal action "${tool}" is not registered.`);
  }
  if (!ctx.companyId?.trim()) {
    return failed(tool, action, `Internal action "${tool}" requires ctx.companyId.`);
  }
  return handler(action, {
    companyId: ctx.companyId,
    actor: ctx.actor ?? "system",
    payload: ctx.payload ?? {},
    store: ctx.store ?? defaultStore,
  });
}

async function readMemory(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const documents = await ctx.store.listDocuments(ctx.companyId);
  const semantic = documents.filter((doc) => doc.memoryTier === "semantic").length;
  return completed("memory:read", action, `Read ${documents.length} memory document(s), including ${semantic} semantic fact document(s).`);
}

async function createTask(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const task = await ctx.store.createTask({
    companyId: ctx.companyId,
    title: text(ctx.payload.title) ?? titleFromAction(action, "Agent follow-up task"),
    prompt: text(ctx.payload.prompt) ?? action,
    status: status(ctx.payload.status, "queued"),
    priority: priority(ctx.payload.priority, "medium"),
    agentRole: role(ctx.payload.agentRole, ctx.actor),
    tags: strings(ctx.payload.tags),
  });
  return completed("tasks:create", action, `Created task ${task.id}: ${task.title}.`);
}

async function blockTask(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const task = await ctx.store.createTask({
    companyId: ctx.companyId,
    title: text(ctx.payload.title) ?? titleFromAction(action, "Blocked work item"),
    prompt: text(ctx.payload.prompt) ?? action,
    status: "blocked",
    priority: priority(ctx.payload.priority, "high"),
    agentRole: role(ctx.payload.agentRole, ctx.actor),
    tags: ["blocked", ...strings(ctx.payload.tags)],
  });
  await ctx.store.addAudit(ctx.companyId, "agent", "task.block", "task", task.id, `Blocked task: ${task.title}`);
  return completed("tasks:block", action, `Blocked task ${task.id}: ${task.title}.`);
}

async function createReport(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const report = await ctx.store.createReport({
    companyId: ctx.companyId,
    type: reportType(ctx.payload.type),
    title: text(ctx.payload.title) ?? titleFromAction(action, "Agent report"),
    findings: strings(ctx.payload.findings, [action]),
    recommendations: strings(ctx.payload.recommendations),
  });
  return completed("reports:create", action, `Created report ${report.id}: ${report.title}.`);
}

async function writeDocument(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: docType(ctx.payload.type),
    title: text(ctx.payload.title) ?? titleFromAction(action, "Agent note"),
    content: text(ctx.payload.content) ?? action,
    source: text(ctx.payload.source) ?? "internal_action:documents:write",
    memoryTier: memoryTier(ctx.payload.memoryTier),
  });
  return completed("documents:write", action, `Wrote document ${document.id}: ${document.title}.`);
}

async function requestApproval(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const approval = await ctx.store.createApproval({
    companyId: ctx.companyId,
    action: text(ctx.payload.action) ?? action,
    reason: text(ctx.payload.reason) ?? `Agent requested approval for: ${action}`,
    toolName: text(ctx.payload.toolName) ?? "internal_action",
    previewContent: text(ctx.payload.previewContent),
    previewKind: previewKind(ctx.payload.previewKind),
  });
  return {
    adapter: "approvals:request",
    action,
    status: "needs_approval",
    summary: `Created approval ${approval.id}: ${approval.action}.`,
  };
}

async function createAudit(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  await ctx.store.addAudit(
    ctx.companyId,
    "agent",
    text(ctx.payload.action) ?? "agent.audit",
    text(ctx.payload.objectType) ?? "internal_action",
    text(ctx.payload.objectId) ?? "seat-tool-contract",
    text(ctx.payload.summary) ?? action,
  );
  return completed("audit:create", action, "Created audit log entry.");
}

async function readUsage(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const usage = await ctx.store.listUsage(ctx.companyId);
  const cents = usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  return completed("usage:read", action, `Read ${usage.length} usage ledger entr${usage.length === 1 ? "y" : "ies"} totaling ${cents} cents.`);
}

async function readBilling(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const [usage, approvals] = await Promise.all([
    ctx.store.listUsage(ctx.companyId),
    ctx.store.listApprovals(ctx.companyId),
  ]);
  const cents = usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  const pending = approvals.filter((approval) => approval.status === "pending").length;
  return completed("billing:read", action, `Read billing context: ${cents} cents in usage and ${pending} pending approval(s).`);
}

async function readGoals(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const company = await ctx.store.getCompany(ctx.companyId);
  return completed("goals:read", action, `Read company goals: ${company?.brief.goals || "No goals recorded."}`);
}

async function updateGoalsDraft(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const company = await ctx.store.getCompany(ctx.companyId);
  if (!company) return failed("goals:update", action, `Company ${ctx.companyId} was not found.`);
  const document = await createDocument(ctx, {
    type: "agent_note",
    title: text(ctx.payload.title) ?? "Goals update draft",
    content: text(ctx.payload.content) ?? text(ctx.payload.goals) ?? action,
    source: "internal_action:goals:update",
    memoryTier: "working",
  });
  return completed("goals:update", action, `Drafted goals update in document ${document.id}; no company goals were mutated without review.`);
}

async function readInboundSupportEmail(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const documents = await ctx.store.listDocuments(ctx.companyId);
  const inbound = documents.filter((doc) => doc.source.startsWith("resend:email.received:"));
  return completed(
    "support:inbound_email",
    action,
    `Read ${inbound.length} inbound support email memory document(s).`,
  );
}

async function draftEmail(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: "email_draft",
    title: text(ctx.payload.title) ?? titleFromAction(action, "Email draft"),
    content: text(ctx.payload.content) ?? action,
    source: "internal_action:email:draft",
    memoryTier: "working",
  });
  return completed("email:draft", action, `Created email draft ${document.id}: ${document.title}.`);
}

async function draftSocial(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: "marketing_plan",
    title: text(ctx.payload.title) ?? titleFromAction(action, "Social post draft"),
    content: text(ctx.payload.content) ?? action,
    source: "internal_action:social:draft",
    memoryTier: "working",
  });
  return completed("social:draft", action, `Created social draft ${document.id}: ${document.title}.`);
}

async function draftAdPlan(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: "marketing_plan",
    title: text(ctx.payload.title) ?? titleFromAction(action, "Ad campaign draft"),
    content: text(ctx.payload.content) ?? action,
    source: "internal_action:ads:draft",
    memoryTier: "working",
  });
  return completed("ads:draft", action, `Created ad draft ${document.id}: ${document.title}.`);
}

async function draftCrmUpdate(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: "agent_note",
    title: text(ctx.payload.title) ?? titleFromAction(action, "CRM update draft"),
    content: text(ctx.payload.content) ?? action,
    source: "internal_action:crm:update_draft",
    memoryTier: "working",
  });
  return completed("crm:update_draft", action, `Created CRM update draft ${document.id}; no CRM record was changed.`);
}

async function researchProspects(action: string, ctx: HandlerContext): Promise<ToolCallRecord> {
  const document = await createDocument(ctx, {
    type: "research",
    title: text(ctx.payload.title) ?? titleFromAction(action, "Prospect research"),
    content: text(ctx.payload.content) ?? action,
    source: "internal_action:prospects:research",
    memoryTier: "working",
  });
  return completed("prospects:research", action, `Stored prospect research ${document.id}: ${document.title}.`);
}

type HandlerContext = Parameters<InternalActionHandler>[1];

async function createDocument(ctx: HandlerContext, input: {
  type: Document["type"];
  title: string;
  content: string;
  source: string;
  memoryTier?: Document["memoryTier"];
}) {
  return ctx.store.createDocument({
    companyId: ctx.companyId,
    type: input.type,
    title: input.title,
    content: input.content,
    source: input.source,
    memoryTier: input.memoryTier,
  });
}

function completed(adapter: string, action: string, summary: string): ToolCallRecord {
  return { adapter, action, status: "completed", summary };
}

function failed(adapter: string, action: string, summary: string): ToolCallRecord {
  return { adapter, action, status: "failed", summary };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return result.length ? result : fallback;
}

function titleFromAction(action: string, fallback: string) {
  const cleaned = action.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function role(value: unknown, actor: AgentRole | "system"): AgentRole {
  if (isAgentRole(value)) return value;
  return actor !== "system" ? actor : "ceo";
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === "ceo"
    || value === "engineer"
    || value === "growth"
    || value === "content"
    || value === "support"
    || value === "analyst"
    || value === "finance"
    || value === "escalation"
    || value === "sales";
}

function priority(value: unknown, fallback: "low" | "medium" | "high" | "urgent") {
  return value === "low" || value === "medium" || value === "high" || value === "urgent"
    ? value
    : fallback;
}

function status(value: unknown, fallback: "draft" | "queued") {
  return value === "draft" || value === "queued" ? value : fallback;
}

function docType(value: unknown): Document["type"] {
  const allowed = new Set<Document["type"]>([
    "brief",
    "roadmap",
    "marketing_plan",
    "research",
    "support_summary",
    "weekly_report",
    "agent_note",
    "feature_gap",
    "email_draft",
  ]);
  return typeof value === "string" && allowed.has(value as Document["type"]) ? value as Document["type"] : "agent_note";
}

function reportType(value: unknown): "cycle" | "weekly" | "growth" | "support" | "finance" | "morning_briefing" {
  return value === "cycle"
    || value === "weekly"
    || value === "growth"
    || value === "support"
    || value === "finance"
    || value === "morning_briefing"
    ? value
    : "cycle";
}

function memoryTier(value: unknown): Document["memoryTier"] {
  return value === "working" || value === "episodic" || value === "semantic" ? value : "working";
}

function previewKind(value: unknown) {
  return value === "email" || value === "post" || value === "diff" || value === "contract" || value === "generic"
    ? value
    : "generic";
}
