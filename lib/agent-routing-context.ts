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

  if (/\b(fincept|ghostfolio|portfolio|holdings|market risk|risk report|finance|billing|ledger|runway|spend|refund|budget|cfo)\b/.test(text)) {
    if (/\bfincept\b/.test(text)) {
      return { role: "finance", tool: "Fincept Terminal", reason: "Fincept Terminal market and finance analysis is granted to Finance." };
    }
    if (/\bghostfolio|holdings|fire|portfolio\b/.test(text)) {
      return { role: "finance", tool: "Ghostfolio", reason: "Portfolio, holdings, wealth, or FIRE work belongs to Finance." };
    }
    return { role: "finance", tool: "Fincept Terminal", reason: "Finance analysis, market-risk, budget, and ledger work belongs to Finance." };
  }

  if (/\b(hyperframes|launch video|motion creative|video creative|render video)\b/.test(text)) {
    return { role: "growth", tool: "HyperFrames", reason: "HyperFrames video creation is granted to Growth / Marketing." };
  }

  if (/\b(open generative ai|image generate|video generate|lip[- ]?sync|cinema workflow|creative generation)\b/.test(text)) {
    return { role: "growth", tool: "Open Generative AI", reason: "Generative campaign creative is granted to Growth / Marketing." };
  }

  if (/\b(support|ticket|customer issue|customer reply|angry customer|escalate.*customer|customer escalation)\b/.test(text)) {
    return { role: "support", tool: "support:read_mock", reason: "Customer issue triage and reply drafting belongs to Support / Ops." };
  }

  if (/\b(sales|prospect|lead|pipeline|crm|outreach|follow[- ]?up|qualification)\b/.test(text)) {
    return { role: "sales", tool: "prospects:research", reason: "Prospecting, qualification, and outbound drafts belong to Sales." };
  }

  if (
    /\b(github|code|bug|test|tests|pr\b|pull request|deploy|repo|implementation|app[- ]?solo|workbench|software|notes app|web app|fix)\b/.test(text)
    || /\bbuild\b.{0,80}\b(app|application|site|dashboard|tool)\b/.test(text)
  ) {
    return { role: "engineer", tool: "github:issue", reason: "Code, repo, test, issue, PR, and deploy planning belongs to Engineer." };
  }

  if (/\b(steel|camofox|browser|web research|competitor|competitors|screenshot|website|web evidence|public pages)\b/.test(text)) {
    return { role: "analyst", tool: "Steel Browser", reason: "Web evidence gathering and screenshots belong to Research / Analyst." };
  }

  if (/\b(audit|critic|unsafe|destructive|approval|legal|privacy|policy|merge|delete|irreversible)\b/.test(text)) {
    return { role: "escalation", tool: "audit:create", reason: "Risk, audit, policy, and irreversible actions belong to Critic / Escalation / Auditor." };
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
