import { AGENT_CATALOG } from "../agents/index.js";
import type { Toolset } from "../config/schema.js";
import { CORE_ROLE_IDS } from "./AgentInstaller.js";
import { PACK_PERSONAS } from "./pack-personas.js";

export interface FleetPack {
  id: string;
  name: string;
  description: string;
  /**
   * What executes today, what waits for a provider the owner connects or an application a platform
   * reviews, and what stays a draft. Rendered by `fleet packs`, so it is the one line a user reads
   * before installing; it must never promise more than the members can do.
   */
  state: string;
  /**
   * The toolsets the pack's skills call (`fleet/pack-skills.test.ts` reads every skill against
   * them): each is carried by at least one member seat, every tool a skill names belongs to one of
   * them, and the skills together call at least one tool of each. Empty for a grouping.
   */
  toolsets: readonly Toolset[];
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

function grouping(pack: Omit<FleetPack, "state" | "skills" | "toolsets">): FleetPack {
  return { ...pack, state: groupingState(pack.agents), skills: [], toolsets: [] };
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
  // is written to `brain/system/` on install. The skills call the pack's toolsets (business
  // and social landed in fd51f62, media before them), every write behind the per-call bound
  // approval. The `state` line is the honest one: what runs once a provider is connected,
  // which platforms still wait for an application, and what stays a draft without either.
  "small-business": {
    id: "small-business",
    name: "Small Business Crew",
    description:
      "Front desk, quotes, invoices and the sign in the window for a spa, a salon or a trade: support, sales, finance and content over the owner's numbers.",
    state:
      "Real calls once the owner connects a provider (trent connect stripe, google, square, twilio; bluesky or buffer for posts): Stripe quotes, invoices and payment links, Google Calendar and Square appointments, Square invoices and outbound-only Twilio texts run through the business toolset (support, sales, finance), and posts and comment replies through the social toolset (content): Bluesky and Buffer today, Facebook and Instagram when Meta is connected and its review passes; Google Business Profile review replies wait for Basic Access. Nothing is sent, booked, invoiced or posted until the owner approves that exact call. Drafts only where no provider is connected: the skills write the same quote, invoice, message or post as a file for the owner to send.",
    agents: ["support", "sales", "finance", "content"],
    skills: ["quote-estimate", "invoice-draft", "booking-followup", "review-response", "local-business-post"],
    toolsets: ["business", "social"],
  },
  social: {
    id: "social",
    name: "Social Media Crew",
    description:
      "A content calendar, the brand's own voice, one idea adapted per platform and a comment triage: content, growth and analyst with the social strategist and content creator.",
    state:
      "Posts, scheduled posts, replies, the comment inbox and post numbers run through the social toolset once an account is connected: Bluesky directly (trent connect bluesky) and any channel Buffer holds (X, LinkedIn, Threads, a Facebook Page; text only) today; Facebook and Instagram directly, and YouTube replies and numbers, when Meta or Google is connected and its review passes (the direct paths also need the app store). No DMs and no YouTube publishing. Nothing is published or replied to until the owner approves that exact call. The content and growth seats make the calls; the analyst seat has no social toolset and reads what they pull. Without a connection the calendar, posts and triage are written as files.",
    agents: ["content", "growth", "analyst", "mkt-social-media-strategist", "mkt-content-creator"],
    skills: ["content-calendar", "brand-voice-capture", "crosspost-adapt", "comment-triage"],
    toolsets: ["social"],
  },
  creator: {
    id: "creator",
    name: "Creator Crew",
    description:
      "Hooks, captions, chapters, a repurposing plan, a ranked clip plan and thumbnails from a long recording: content with the short-video coach, the video optimisation specialist and the image prompt engineer.",
    state:
      "Clipping, transcription and thumbnails work when a media backend is installed (ffmpeg on PATH, or the image from `trent sandbox build --media`; the Media Pipeline line of `trent doctor` says which) and the media toolset is on (quick setup turns it on when it finds a backend): the crew probes, transcribes, finds the cuts, clips to 9:16 with burned captions and extracts frames into the workspace; a generated thumbnail image costs cents and asks first. Without a backend it works in text from a transcript the owner supplies. Nothing is uploaded or published; the owner posts.",
    agents: ["content", "mkt-short-video-editing-coach", "mkt-video-optimization-specialist", "design-image-prompt-engineer"],
    skills: ["hook-lab", "caption-and-chapters", "repurpose-plan", "clip-plan", "thumbnail-brief"],
    toolsets: ["media"],
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
