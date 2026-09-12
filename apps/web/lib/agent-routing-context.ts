import {
  AGENT_SLOTS,
  buildSlotEnvironment,
} from "@/lib/agent-catalog";
import { buildOrchestratorSeatDossier } from "@/lib/seat-manifest";
import type { AgentRole } from "@/lib/types";

export type SeatRouteRecommendation = {
  role: AgentRole;
  tool: string;
  reason: string;
};

export function recommendSeatForObjective(objective: string): SeatRouteRecommendation {
  const text = objective.toLowerCase();

  // SHRINK: Finance is a shelved seat — its oversight folds into the Operator (ceo).
  if (/\b(fincept|ghostfolio|portfolio|holdings|market risk|risk report|finance|billing|ledger|runway|spend|refund|budget|cfo)\b/.test(text)) {
    if (/\bfincept\b/.test(text)) {
      return { role: "ceo", tool: "Stripe", reason: "Fincept Terminal is not installed as a verified sandbox app; the Operator handles finance oversight using real billing, usage, and Stripe evidence (a dedicated Finance seat is shelved)." };
    }
    if (/\bghostfolio|holdings|fire|portfolio\b/.test(text)) {
      return { role: "ceo", tool: "Stripe", reason: "Ghostfolio is not installed as a verified sandbox app; the Operator handles portfolio/finance oversight using available real financial evidence (a dedicated Finance seat is shelved)." };
    }
    return { role: "ceo", tool: "Stripe", reason: "Finance oversight (billing, usage, budget, ledger, market-risk) is handled by the Operator using real Stripe evidence; a dedicated Finance seat is shelved until a tenant workflow demands one." };
  }

  if (/\b(hyperframes|launch video|motion creative|video creative|render video)\b/.test(text)) {
    return { role: "growth", tool: "documents:write", reason: "HyperFrames is not installed as a verified rendering app; Growth should draft the campaign creative brief and route build work to Workbench if needed." };
  }

  if (/\b(open generative ai|image generate|video generate|lip[- ]?sync|cinema workflow|creative generation)\b/.test(text)) {
    return { role: "growth", tool: "documents:write", reason: "Open Generative AI is not installed as a verified creative app; Growth should draft the creative brief and approval plan with available tools." };
  }

  if (/\b(support|ticket|customer issue|customer reply|angry customer|escalate.*customer|customer escalation)\b/.test(text)) {
    return { role: "support", tool: "support:inbound_email", reason: "Customer issue triage and reply drafting belongs to Support / Ops." };
  }

  // SHRINK: Sales is a shelved seat — go-to-market folds into Growth.
  if (/\b(sales|prospect|lead|pipeline|crm|outreach|follow[- ]?up|qualification)\b/.test(text)) {
    return { role: "growth", tool: "prospects:research", reason: "Prospecting, qualification, pipeline, and outbound drafts are handled by Growth as part of go-to-market; a dedicated Sales seat is shelved." };
  }

  if (
    /\b(github|code|bug|test|tests|pr\b|pull request|deploy|repo|implementation|app[- ]?solo|workbench|software|notes app|web app|fix)\b/.test(text)
    || /\bbuild\b.{0,80}\b(app|application|site|dashboard|tool)\b/.test(text)
  ) {
    return { role: "engineer", tool: "Workbench Sandbox", reason: "Code, repo, test, issue, PR, and deploy planning belongs to Engineer." };
  }

  // SHRINK: Analyst is a shelved seat — web-evidence/research synthesis folds into the Operator (ceo).
  if (/\b(steel|camofox|browser|web research|competitor|competitors|screenshot|website|web evidence|public pages)\b/.test(text)) {
    return { role: "ceo", tool: "Steel Browser", reason: "Web-evidence gathering, competitor research, and analysis synthesis are coordinated by the Operator; a dedicated Analyst seat is shelved." };
  }

  // SHRINK: Escalation is not a seat — risk/audit/approval is a feature of the approval flow, owned by the Operator.
  if (/\b(audit|critic|unsafe|destructive|approval|legal|privacy|policy|merge|delete|irreversible)\b/.test(text)) {
    return { role: "ceo", tool: "audit:create", reason: "Risk, audit, policy, and irreversible-action review is owned by the Operator through the approval gate." };
  }

  if (/\b(copy|content|design|landing page|email draft|visual|slides|presentation)\b/.test(text)) {
    return { role: "content", tool: "documents:write", reason: "Design, copy, documents, and content drafts belong to Design / Content." };
  }

  if (/\b(campaign|seo|ad|ads|growth|audience|funnel|activation|plg)\b/.test(text)) {
    return { role: "growth", tool: "ads:draft", reason: "Campaigns, funnels, audiences, and PLG work belongs to Growth / Marketing." };
  }

  return { role: "ceo", tool: "tasks:create", reason: "Ambiguous or cross-functional work starts with CEO coordination." };
}

export function formatRouteRecommendation(label: string, recommendation: SeatRouteRecommendation) {
  return `Recommended route for this ${label}: ${recommendation.role} via ${recommendation.tool}. Reason: ${recommendation.reason}`;
}

export function buildAgentRoutingContext(companyId: string): string {
  const dossier = buildOrchestratorSeatDossier();
  const slotLabels = new Map(AGENT_SLOTS.map((slot) => [slot.role, `${slot.label} — ${slot.defaultName}`]));

  const seats = dossier.seats.map((seat) => {
    const environment = buildSlotEnvironment(companyId, seat.role);
    return [
      `- ${slotLabels.get(seat.role) ?? seat.name} (${seat.role}, ${seat.modelTier}, ${seat.qualityLabel})`,
      `  use when: ${seat.whenToUse}`,
      `  do not use when: ${seat.whenNotToUse}`,
      `  methodology: ${seat.methodology}`,
      `  manifest tools: ${seat.tools.map((tool) => tool.name).join(", ")}`,
      `  runtime tools: ${environment.tools.join(", ")}`,
      `  skills: ${(environment.skills ?? []).join(", ") || "none"}`,
      `  approval gates: ${environment.approvalRequiredFor.join(", ") || "none"}`,
      `  outputs: ${environment.outputContract.join(", ")}`,
      `  context: ${seat.contextNeeds.join(", ")}`,
    ].join("\n");
  });

  return [
    "CEO routing dossier",
    dossier.routingRule,
    "Use this map before assigning work. Prefer the smallest capable seat and mention the selected tool/app when the request names one.",
    ...seats,
  ].join("\n");
}
