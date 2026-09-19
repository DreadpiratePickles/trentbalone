import {
  AGENT_SLOTS,
  SLOT_ENVIRONMENTS,
  buildSlotEnvironment,
} from "@/lib/agent-catalog";
import { buildOrchestratorSeatDossier, getSeatManifest } from "@/lib/seat-manifest";
import type { AgentRole } from "@/lib/types";

export type SeatRouteRecommendation = {
  role: AgentRole;
  tool: string;
  reason: string;
};

/** A tool the seat actually carries at runtime, so a recommendation can never name one it lacks. */
function seatTool(role: AgentRole, preferred: string): string {
  const tools = SLOT_ENVIRONMENTS[role].tools;
  return tools.includes(preferred) ? preferred : tools[0];
}

/**
 * UNSHELVED 2026-09-18: every seat routes to itself again. Until today finance,
 * analyst and escalation objectives were handed to ceo and sales objectives to
 * growth, and the reason text told the planner those seats were shelved — which
 * `repairOrchestrationPlanRoutes` then turned into a growth step on a sales plan.
 *
 * The reason is the seat's own manifest remit rather than hand-written prose, so the
 * routing hint and the seat dossier can never drift apart. `note` carries the one
 * thing a manifest cannot know: that a third-party app named in the objective is not
 * installed as a verified app, so the seat must work from evidence it really has.
 */
function routeTo(role: AgentRole, preferred: string, note?: string): SeatRouteRecommendation {
  const manifest = getSeatManifest(role);
  const remit = `${manifest.name} owns this work: ${manifest.whenToUse}`;
  return { role, tool: seatTool(role, preferred), reason: note ? `${note}. ${remit}` : remit };
}

export function recommendSeatForObjective(objective: string): SeatRouteRecommendation {
  const text = objective.toLowerCase();

  if (/\b(fincept|ghostfolio|portfolio|holdings|market risk|risk report|finance|billing|ledger|runway|spend|refund|budget|cfo)\b/.test(text)) {
    if (/\bfincept\b/.test(text)) {
      return routeTo("finance", "Stripe", "Fincept Terminal is not installed as a verified sandbox app; work from real billing, usage and Stripe evidence");
    }
    if (/\bghostfolio|holdings|fire|portfolio\b/.test(text)) {
      return routeTo("finance", "Stripe", "Ghostfolio is not installed as a verified sandbox app; work from the financial evidence the seat can actually read");
    }
    return routeTo("finance", "Stripe");
  }

  if (/\b(hyperframes|launch video|motion creative|video creative|render video)\b/.test(text)) {
    return routeTo("growth", "documents:write", "HyperFrames is not installed as a verified rendering app; draft the campaign creative brief and route build work to Workbench if needed");
  }

  if (/\b(open generative ai|image generate|video generate|lip[- ]?sync|cinema workflow|creative generation)\b/.test(text)) {
    return routeTo("growth", "documents:write", "Open Generative AI is not installed as a verified creative app; draft the creative brief and approval plan with available tools");
  }

  // Customer-shaped escalations stay with Support; the escalation seat below owns the
  // risk/approval class of decision, not the customer conversation.
  if (/\b(support|ticket|customer issue|customer reply|angry customer|escalate.*customer|customer escalation)\b/.test(text)) {
    return routeTo("support", "support:inbound_email");
  }

  if (/\b(sales|prospect|lead|pipeline|crm|outreach|follow[- ]?up|qualification)\b/.test(text)) {
    return routeTo("sales", "prospects:research");
  }

  if (
    /\b(github|code|bug|test|tests|pr\b|pull request|deploy|repo|implementation|app[- ]?solo|workbench|software|notes app|web app|fix)\b/.test(text)
    || /\bbuild\b.{0,80}\b(app|application|site|dashboard|tool)\b/.test(text)
  ) {
    return routeTo("engineer", "Workbench Sandbox");
  }

  if (/\b(steel|camofox|browser|web research|competitor|competitors|screenshot|website|web evidence|public pages)\b/.test(text)) {
    return routeTo("analyst", "Steel Browser");
  }

  if (/\b(audit|critic|unsafe|destructive|approval|legal|privacy|policy|merge|delete|irreversible)\b/.test(text)) {
    return routeTo("escalation", "audit:create");
  }

  if (/\b(copy|content|design|landing page|email draft|visual|slides|presentation)\b/.test(text)) {
    return routeTo("content", "documents:write");
  }

  if (/\b(campaign|seo|ad|ads|growth|audience|funnel|activation|plg)\b/.test(text)) {
    return routeTo("growth", "ads:draft");
  }

  return routeTo("ceo", "tasks:create");
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
