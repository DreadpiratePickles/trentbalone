import type {
  AgentRole,
  Artifact,
  ArtifactExportFormat,
  ArtifactType,
  CeoArtifactRequest,
  Company,
  Cycle,
  Document,
  Report,
  Task
} from "@/lib/types";
import { nowIso } from "@/lib/utils";
import { buildSourceCoverage, selectRelevantDocuments } from "@/lib/source-coverage";

export const ARTIFACT_TYPE_META: Record<
  ArtifactType,
  { label: string; defaultFormat: ArtifactExportFormat; agentRole: AgentRole; description: string }
> = {
  board_pdf: {
    label: "Board PDF",
    defaultFormat: "pdf",
    agentRole: "finance",
    description: "Board-ready operating packet with metrics, risks, asks, and decisions."
  },
  xlsx_report: {
    label: "XLSX Report",
    defaultFormat: "xlsx",
    agentRole: "analyst",
    description: "Spreadsheet-style report with metric rows and action ownership."
  },
  dashboard: {
    label: "Dashboard",
    defaultFormat: "dashboard_json",
    agentRole: "analyst",
    description: "In-app dashboard spec with KPI cards, tables, and chart-ready data."
  },
  investor_update: {
    label: "Investor Update",
    defaultFormat: "html",
    agentRole: "finance",
    description: "Concise update covering progress, metrics, risks, and asks."
  },
  campaign_report: {
    label: "Campaign Report",
    defaultFormat: "csv",
    agentRole: "growth",
    description: "Growth report with experiments, channels, signals, and next actions."
  },
  competitive_research: {
    label: "Competitive Research",
    defaultFormat: "html",
    agentRole: "analyst",
    description: "Competitor comparison, positioning gaps, and recommended moves."
  },
  operating_memo: {
    label: "Operating Memo",
    defaultFormat: "markdown",
    agentRole: "ceo",
    description: "Decision memo for company priorities, tradeoffs, and execution plan."
  },
  support_summary: {
    label: "Support Summary",
    defaultFormat: "markdown",
    agentRole: "support",
    description: "Support themes, customer pain, escalations, and product follow-ups."
  }
};

export type ArtifactBuildInput = {
  company: Company;
  prompt: string;
  type: ArtifactType;
  title?: string;
  createdByAgent?: AgentRole;
  exportFormat?: ArtifactExportFormat;
  tasks: Task[];
  cycles: Cycle[];
  documents: Document[];
  reports: Report[];
};

export type ArtifactDraft = Omit<Artifact, "id" | "createdAt" | "updatedAt">;

export function inferArtifactRequest(message: string): CeoArtifactRequest | undefined {
  const lower = message.toLowerCase();
  const wantsArtifact =
    lower.includes("artifact") ||
    lower.includes("pdf") ||
    lower.includes("xlsx") ||
    lower.includes("spreadsheet") ||
    lower.includes("dashboard") ||
    lower.includes("board") ||
    lower.includes("investor") ||
    lower.includes("competitive") ||
    lower.includes("competitor") ||
    lower.includes("campaign report") ||
    lower.includes("memo") ||
    lower.includes("support summary");

  if (!wantsArtifact) return undefined;

  const type = inferArtifactType(lower);
  const meta = ARTIFACT_TYPE_META[type];
  return {
    title: inferArtifactTitle(type),
    prompt: message,
    type,
    createdByAgent: meta.agentRole,
    exportFormat: meta.defaultFormat
  };
}

export function buildArtifactDraft(input: ArtifactBuildInput): ArtifactDraft {
  const meta = ARTIFACT_TYPE_META[input.type];
  const generatedAt = nowIso();
  const activeTasks = input.tasks.filter((task) => task.status === "queued" || task.status === "running");
  const pendingApprovals = input.tasks.filter((task) => task.status === "waiting_approval");
  const lastCycle = input.cycles[0];
  // RC1 (Fix Plan Slice 6): pick documents by relevance to the request, not
  // recency, and report required-vs-missing source coverage in the artifact.
  const recentDocs = selectRelevantDocuments(input.prompt, input.documents, 5);
  const coverage = buildSourceCoverage(input.prompt, input.documents);
  const recentReports = input.reports.slice(0, 3);
  const sources = [
    "company operating brief",
    ...recentDocs.map((doc) => `document:${doc.title}`),
    ...recentReports.map((report) => `report:${report.title}`),
    ...(lastCycle ? [`cycle:${lastCycle.id}`] : [])
  ];

  const title = input.title?.trim() || inferArtifactTitle(input.type, input.company.name);
  const summary = [
    meta.description,
    `Generated for ${input.company.name} from ${sources.length} source${sources.length === 1 ? "" : "s"}.`
  ].join(" ");

  const content = [
    `# ${title}`,
    "",
    `Generated: ${new Date(generatedAt).toLocaleString("en-US", { timeZone: input.company.timezone })}`,
    `Artifact type: ${meta.label}`,
    `Prepared by: ${input.createdByAgent ?? meta.agentRole}`,
    "",
    "## Executive Summary",
    buildExecutiveSummary(input.company, input.prompt, activeTasks, pendingApprovals),
    "",
    "## Company Snapshot",
    `- Vision: ${input.company.brief.vision || "Not yet defined."}`,
    `- ICP: ${input.company.brief.icp || "Not yet defined."}`,
    `- Offer: ${input.company.brief.offer || "Not yet defined."}`,
    `- Goals: ${input.company.brief.goals || "Not yet defined."}`,
    `- Constraints: ${input.company.brief.constraints || "Not yet defined."}`,
    "",
    buildTypeSpecificSection(input.type, input.company, input.tasks, input.reports),
    "",
    "## Action List",
    ...buildActionList(input.type, activeTasks, pendingApprovals),
    "",
    "## Source Notes",
    ...sources.map((source) => `- ${source}`),
    ...(coverage.required.length > 0
      ? [
          "",
          "## Source Coverage",
          ...(coverage.used.length > 0
            ? [`- Available and used: ${coverage.used.map((u) => `${u.need.label} (${u.title})`).join(", ")}`]
            : ["- Available and used: none of the required sources"]),
          ...(coverage.missing.length > 0
            ? [`- Missing (not in company memory — upload to improve this artifact): ${coverage.missing.map((m) => m.label).join(", ")}`]
            : ["- Missing: none"]),
        ]
      : []),
    "",
    "## Provenance",
    `- Request: ${input.prompt}`,
    "- Model: artifact-template-v1",
    "- External sends: none",
    "- Approval state: draft-ready; human approval required before sending externally"
  ].join("\n");

  return {
    companyId: input.company.id,
    type: input.type,
    status: requiresApproval(input.type) ? "needs_approval" : "ready",
    title,
    summary,
    content,
    exportFormat: input.exportFormat ?? meta.defaultFormat,
    createdByAgent: input.createdByAgent ?? meta.agentRole,
    approvalStatus: requiresApproval(input.type) ? "pending" : undefined,
    provenance: {
      prompt: input.prompt,
      sources,
      model: "artifact-template-v1",
      tokens: 0,
      costCents: 0,
      generatedAt
    }
  };
}

export function artifactToHtml(artifact: Artifact): string {
  const body = markdownToBasicHtml(artifact.content);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\" />",
    `<title>${escapeHtml(artifact.title)}</title>`,
    "<style>",
    "body{font-family:Inter,Arial,sans-serif;max-width:920px;margin:40px auto;padding:0 28px;color:#111827;line-height:1.55}",
    "h1{font-size:32px;margin-bottom:8px}h2{font-size:18px;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:18px}",
    "li{margin:6px 0}code{background:#f3f4f6;padding:2px 4px;border-radius:4px}",
    ".meta{color:#6b7280;font-size:12px;margin-bottom:24px}",
    "</style>",
    "</head>",
    "<body>",
    `<div class=\"meta\">${escapeHtml(ARTIFACT_TYPE_META[artifact.type].label)} · ${escapeHtml(artifact.status)} · ${escapeHtml(artifact.createdAt)}</div>`,
    body,
    "</body>",
    "</html>"
  ].join("");
}

export function artifactToCsv(artifact: Artifact): string {
  const rows = [
    ["Section", "Item", "Value"],
    ["Artifact", "Title", artifact.title],
    ["Artifact", "Type", ARTIFACT_TYPE_META[artifact.type].label],
    ["Artifact", "Status", artifact.status],
    ["Summary", "Overview", artifact.summary],
    ["Provenance", "Request", artifact.provenance.prompt],
    ["Provenance", "Sources", artifact.provenance.sources.join("; ")]
  ];

  const actionLines = artifact.content
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .slice(0, 20);
  actionLines.forEach((line, index) => rows.push(["Extracted bullet", String(index + 1), line.slice(2)]));

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function inferArtifactType(lowerMessage: string): ArtifactType {
  if (lowerMessage.includes("xlsx") || lowerMessage.includes("spreadsheet")) return "xlsx_report";
  if (lowerMessage.includes("dashboard")) return "dashboard";
  if (lowerMessage.includes("board")) return "board_pdf";
  if (lowerMessage.includes("investor")) return "investor_update";
  if (lowerMessage.includes("campaign")) return "campaign_report";
  if (lowerMessage.includes("competitive") || lowerMessage.includes("competitor")) return "competitive_research";
  if (lowerMessage.includes("support")) return "support_summary";
  if (lowerMessage.includes("memo")) return "operating_memo";
  if (lowerMessage.includes("pdf")) return "board_pdf";
  return "operating_memo";
}

function inferArtifactTitle(type: ArtifactType, companyName = "Company"): string {
  const labels: Record<ArtifactType, string> = {
    board_pdf: `${companyName} Board Packet`,
    xlsx_report: `${companyName} Metrics Workbook`,
    dashboard: `${companyName} Operating Dashboard`,
    investor_update: `${companyName} Investor Update`,
    campaign_report: `${companyName} Campaign Report`,
    competitive_research: `${companyName} Competitive Research`,
    operating_memo: `${companyName} Operating Memo`,
    support_summary: `${companyName} Support Summary`
  };
  return labels[type];
}

function buildExecutiveSummary(
  company: Company,
  prompt: string,
  activeTasks: Task[],
  pendingApprovals: Task[]
): string {
  return [
    `${company.name} is currently operating toward: ${company.brief.goals || "a clearer company goal"}.`,
    `The founder asked: "${prompt}".`,
    `There are ${activeTasks.length} queued/running task${activeTasks.length === 1 ? "" : "s"} and ${pendingApprovals.length} approval-gated item${pendingApprovals.length === 1 ? "" : "s"}.`,
    "This artifact is safe to review in-app and should be approved before it is sent, published, or attached to an external destination."
  ].join(" ");
}

function buildTypeSpecificSection(
  type: ArtifactType,
  company: Company,
  tasks: Task[],
  reports: Report[]
): string {
  if (type === "competitive_research") {
    return [
      "## Competitive Positioning",
      `- Known competitors: ${company.brief.competitors || "Not yet listed."}`,
      `- Differentiation angle: Trent is an in-app operating coworker with approvals, artifacts, agent slots, and company memory.`,
      "- Recommended next move: turn competitor claims into a gap matrix and ship one artifact-backed proof point."
    ].join("\n");
  }

  if (type === "campaign_report") {
    return [
      "## Campaign Readout",
      "- Channel: founder/community distribution first; paid channels stay approval-gated.",
      `- Offer: ${company.brief.offer || "Not yet defined."}`,
      "- Signal to watch: qualified replies, demo bookings, trial activation, and approved spend."
    ].join("\n");
  }

  if (type === "dashboard") {
    return [
      "## Dashboard Spec",
      `- KPI cards: users (${company.metrics.users}), signups (${company.metrics.signups}), revenue ($${(company.metrics.revenueCents / 100).toFixed(2)}), retention (${Math.round(company.metrics.retentionRate * 100)}%).`,
      "- Tables: active tasks, pending approvals, recent reports, usage ledger.",
      "- Charts: signup trend, cost per task, approval aging, cycle completion."
    ].join("\n");
  }

  if (type === "support_summary") {
    return [
      "## Support Themes",
      "- No live support inbox is connected yet; this summary uses current tasks and company memory.",
      "- Escalate account, billing, destructive, and public-response actions for human approval.",
      "- Convert repeated support themes into product tasks and knowledge base drafts."
    ].join("\n");
  }

  const recentTaskLines = tasks.slice(0, 5).map((task) => `- [${task.status}] ${task.title} (${task.agentRole})`);
  const recentReportLines = reports.slice(0, 3).map((report) => `- ${report.title}`);
  return [
    "## Operating Detail",
    recentTaskLines.length ? recentTaskLines.join("\n") : "- No recent tasks found.",
    "",
    "## Recent Reports",
    recentReportLines.length ? recentReportLines.join("\n") : "- No recent reports found."
  ].join("\n");
}

function buildActionList(type: ArtifactType, activeTasks: Task[], pendingApprovals: Task[]): string[] {
  const base = [
    "- Review this artifact in Command Center.",
    "- Attach it to the relevant task/report once approved.",
    "- Regenerate after the next cycle if key inputs change."
  ];
  if (pendingApprovals.length) {
    base.unshift(`- Resolve ${pendingApprovals.length} pending approval-gated task${pendingApprovals.length === 1 ? "" : "s"}.`);
  }
  if (activeTasks.length) {
    base.push(`- Monitor ${activeTasks.length} active task${activeTasks.length === 1 ? "" : "s"} before sending externally.`);
  }
  if (requiresApproval(type)) {
    base.push("- Require human approval before sending, publishing, or sharing this artifact.");
  }
  return base;
}

function requiresApproval(type: ArtifactType): boolean {
  return type === "board_pdf" || type === "investor_update" || type === "campaign_report";
}

function markdownToBasicHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("- ")) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line.trim()) return "";
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("\n")
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function csvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
