import { AGENT_CATALOG } from "../agents/index.js";
import { CORE_ROLE_IDS } from "./AgentInstaller.js";
import { PACK_PERSONAS } from "./pack-personas.js";

export interface FleetPack {
  id: string;
  name: string;
  description: string;
  /**
   * What executes today and what stays a draft until a toolset lands. Rendered by `fleet packs`,
   * so it is the one line a user reads before installing; it must never promise more than the
   * members can do.
   */
  state: string;
  /** Every id here is installed by `installPack`. The label must match this length. */
  agents: string[];
  /**
   * Skill slugs installed into the profile store with the pack, resolved from the app bundle or
   * the core source (`SkillProvisioner`). They belong to the profile, not to a member: every seat
   * sees them through `skills_list`, and uninstalling a member leaves them.
   */
  skills: string[];
}

/** All 164 specialist ids, in catalog order. */
const ALL_SPECIALIST_IDS: string[] = AGENT_CATALOG.map((agent) => agent.id);

/**
 * The truthful state of a pack that is only a grouping: seats run in the planner, specialists are
 * catalog profiles the planner never schedules on their own (RA section 4). Derived from the
 * membership so the line cannot drift from what the pack installs.
 */
function groupingState(agents: readonly string[]): string {
  const seats = agents.filter((id) => CORE_ROLE_IDS.includes(id));
  const specialists = agents.length - seats.length;
  if (specialists === 0) return "Seats only: each runs in the planner with its own toolsets, budget and eval suite.";
  if (seats.length === 0) {
    return "Specialists only: each installs its catalog profile and skills; the planner still routes work to the nine seats, so nothing here runs on its own.";
  }
  return "The seats run in the planner; the specialists install profiles and skills the seats can read and are not scheduled on their own.";
}

function grouping(pack: Omit<FleetPack, "state" | "skills">): FleetPack {
  return { ...pack, state: groupingState(pack.agents), skills: [] };
}

export const FLEET_PACKS: Record<string, FleetPack> = {
  engineering: grouping({
    id: "engineering",
    name: "Engineering Pack",
    description: "Full-stack software delivery team: AI engineer, frontend, backend, devops, and QA.",
    agents: [
      "eng-ai-engineer",
      "eng-frontend-developer",
      "eng-backend-architect",
      "eng-devops-automator",
      "spec-model-qa",
    ],
  }),
  marketing: grouping({
    id: "marketing",
    name: "Marketing & Growth Pack",
    description: "Acquisition and narrative engine: growth hacker, search optimizer, citation strategist.",
    agents: [
      "growth",
      "content",
      "mkt-agentic-search-optimizer",
      "mkt-ai-citation-strategist",
    ],
  }),
  finance: grouping({
    id: "finance",
    name: "Finance & Treasury Pack",
    description: "Financial controls, bookkeeping, FP&A modeling, and tax strategy.",
    agents: [
      "finance",
      "fin-bookkeeper-controller",
      "fin-financial-analyst",
      "fin-fpa-analyst",
      "fin-tax-strategist",
    ],
  }),
  support: grouping({
    id: "support",
    name: "Customer Support & Success Pack",
    description: "24/7 omni-channel support, escalations, and analytics reporting.",
    agents: [
      "support",
      "sup-support-responder",
      "sup-analytics-reporter",
      "sup-executive-summary-generator",
    ],
  }),
  executive: grouping({
    id: "executive",
    name: "Executive Leadership Pack",
    description: "Strategic decision-making team: CEO, Lead Engineer, Growth Hacker, and Finance Lead.",
    agents: [
      "ceo",
      "engineer",
      "growth",
      "finance",
    ],
  }),
  "eng-trio": grouping({
    id: "eng-trio",
    name: "Engineering Trio",
    description: "Core software engineering squad: AI Engineer, Backend Architect, DevOps.",
    agents: ["engineer", "eng-ai-engineer", "eng-backend-architect"],
  }),
  "growth-engine": grouping({
    id: "growth-engine",
    name: "Growth Engine",
    description: "High-leverage growth & distribution squad.",
    agents: ["growth", "content", "mkt-agentic-search-optimizer"],
  }),
  revops: grouping({
    id: "revops",
    name: "Revenue Operations Pack",
    description: "Finance and customer success alignment team.",
    agents: ["finance", "support", "fin-bookkeeper-controller"],
  }),
  "security-audit": grouping({
    id: "security-audit",
    name: "Security & Compliance Pack",
    description: "Code audit, dependency scan, and risk assessment.",
    agents: ["escalation", "eng-ai-engineer"],
  }),
  "core-roles": grouping({
    id: "core-roles",
    name: "Core Roles",
    // Named from the roster itself, so a seat can never be advertised here and be missing
    // from the install (it advertised `browser`, which stopped being a seat on 2026-09-18).
    description: `The ${CORE_ROLE_IDS.length} built-in cofounder roles: ${CORE_ROLE_IDS.join(", ")}.`,
    agents: [...CORE_ROLE_IDS],
  }),
  // The label used to promise 164 specialists and install nine core roles. It now installs the
  // 164; the nine core roles are their own pack above.
  all: grouping({
    id: "all",
    name: "Full 164-Specialist Fleet",
    description: "Deploy every specialist in the catalog, across all 13 divisions.",
    agents: ALL_SPECIALIST_IDS,
  }),

  // ---------------------------------------------------------------------------------------
  // The three market packs (upgrade round, decision A3). Each is a crew over existing seats
  // plus the trade skills in `packages/trent-core/skills/`; the persona in `pack-personas.ts`
  // is written to `brain/system/` on install. The `state` line is the honest one: the CLI
  // executes none of the side effects these trades need until a toolset lands.
  "small-business": {
    id: "small-business",
    name: "Small Business Crew",
    description:
      "Front desk, quotes, invoices and the sign in the window for a spa, a salon or a trade: support, sales, finance and content over the owner's numbers.",
    state:
      "Drafts only: quotes, invoices, follow-ups, review replies and posts are written as files for the owner to send. Nothing is sent, booked, invoiced or posted until the business toolset (Stripe, Google Calendar, Square, Twilio) lands; every one of those will then need the owner's approval.",
    agents: ["support", "sales", "finance", "content"],
    skills: ["quote-estimate", "invoice-draft", "booking-followup", "review-response", "local-business-post"],
  },
  social: {
    id: "social",
    name: "Social Media Crew",
    description:
      "A content calendar, the brand's own voice, one idea adapted per platform and a comment triage: content, growth and analyst with the social strategist and content creator.",
    state:
      "Drafts and plans only: the calendar, posts, adaptations and comment triage are written as files. No account is connected and nothing is published or replied to until the social toolset lands, after the business and media toolsets; publishing will need the owner's approval per post.",
    agents: ["content", "growth", "analyst", "mkt-social-media-strategist", "mkt-content-creator"],
    skills: ["content-calendar", "brand-voice-capture", "crosspost-adapt", "comment-triage"],
  },
  creator: {
    id: "creator",
    name: "Creator Crew",
    description:
      "Hooks, captions, chapters, repurposing plans and thumbnail briefs from a transcript: content with the short-video coach, the video optimisation specialist and the image prompt engineer.",
    state:
      "Text only: hooks, captions, chapters, repurposing plans and thumbnail briefs from a transcript or notes the owner supplies. No clipping, transcription or image rendering until the media toolset lands (in progress); the plans name the cuts and the owner makes them.",
    agents: ["content", "mkt-short-video-editing-coach", "mkt-video-optimization-specialist", "design-image-prompt-engineer"],
    skills: ["hook-lab", "caption-and-chapters", "repurpose-plan", "thumbnail-brief"],
  },
};

/** Hard cap on one persona's bytes: under the brain's per-file prompt limit with room to spare. */
export const PERSONA_LIMIT_CHARS = 1_800;

/** The persona block a pack writes on install, or null for a pack that is only a grouping. */
export function packPersona(pack: Pick<FleetPack, "id">): string | null {
  return PACK_PERSONAS[pack.id] ?? null;
}

/** Where the persona lives inside `brain/`. */
export function personaPathFor(pack: Pick<FleetPack, "id">): string {
  return `system/persona-${pack.id}.md`;
}

/** True only for an exact pack id (case and surrounding space aside); aliases do not count. */
export function isFleetPackId(query: string): boolean {
  const norm = query.toLowerCase().trim();
  return norm !== "" && Object.prototype.hasOwnProperty.call(FLEET_PACKS, norm);
}

export function resolveFleetPack(packId: string): FleetPack | undefined {
  const norm = packId.toLowerCase().trim();
  if (FLEET_PACKS[norm]) return FLEET_PACKS[norm];
  if (norm.includes("eng")) return FLEET_PACKS["engineering"] || FLEET_PACKS["eng-trio"];
  if (norm.includes("growth") || norm.includes("market")) return FLEET_PACKS["marketing"] || FLEET_PACKS["growth-engine"];
  if (norm.includes("fin")) return FLEET_PACKS["finance"];
  if (norm.includes("supp")) return FLEET_PACKS["support"];
  if (norm.includes("exec")) return FLEET_PACKS["executive"];
  return undefined;
}
