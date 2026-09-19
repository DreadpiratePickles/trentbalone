/**
 * What makes a seat a seat (B2).
 *
 * The audit (`01_discovery/output/fleet-brain-audit-2026-09-18.md` §1.5) found the nine seats
 * collapsing into one loop with a different prompt: the CLI handed every seat the SAME adapter list
 * (`orchestrator/seat-wiring.ts` looped `SEAT_ROLES` over one array), the per-run cap was rendered
 * into the prompt and never compared to spend, and one configured model was written into all three
 * tier variables. This module is the missing half: the app's manifests say what a seat may do, and
 * the wrapper enforces it.
 *
 * There is no second roster. `SLOT_ENVIRONMENTS` (`apps/web/lib/agent-catalog.ts`) is the single
 * source of truth for a seat's capabilities, approval gates and per-run cap in INTEGER CENTS, and
 * `SEAT_MANIFESTS` (`apps/web/lib/seat-manifest.ts`) for its model tier. Everything here is derived
 * from those two tables; the only thing this file adds is the translation from an app capability
 * string onto one of Trent's own toolsets, and the honest admission that the CLI executes none of
 * the hosted SaaS capabilities (`Email`, `Stripe`, `crm:read`, ...).
 */

import { SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import { SEAT_MANIFESTS, type SeatModelTier } from "@/lib/seat-manifest";
import type { AgentRole } from "@/lib/types";
import type { Toolset } from "../config/schema.js";
import { EXIT, TrentError } from "../errors/index.js";

/**
 * App capability -> the Trent toolset that executes it. A capability absent from this table is one
 * the CLI cannot execute; it is reported `unavailable` on the seat rather than advertised.
 *
 * The mapping is deliberately narrow. `documents:write` and `reports:create` are artefacts written
 * into the workspace (`file_ops`); `Workbench Sandbox` / `workbench:session` are the sandboxed
 * shell (`terminal`); `sandbox:exec` and `tests:run` run code in it (`code`); the Steel scrape and
 * PDF scopes are fetch-and-extract (`web`) while the session, screenshot and browser scopes drive a
 * real page (`browser`); the vault and gitnexus scopes are the shared brain (`memory`); and an
 * approval request is the founder prompt (`human`).
 */
export const CAPABILITY_TOOLSETS: Readonly<Record<string, Toolset>> = {
  // Artefacts on disk.
  "documents:write": "file_ops",
  "reports:create": "file_ops",
  // The sandboxed shell, and code inside it.
  "Workbench Sandbox": "terminal",
  "workbench:session": "terminal",
  "sandbox:exec": "code",
  "tests:run": "code",
  // The shared brain.
  "memory:read": "memory",
  "Vault Memory": "memory",
  "vault:read": "memory",
  "vault:write": "memory",
  "vault:graph": "memory",
  "gitnexus:search": "memory",
  "gitnexus:context": "memory",
  // The web, in its two shapes.
  "Steel Browser": "browser",
  "steel:sessions": "browser",
  "steel:screenshot": "browser",
  "steel:scrape": "web",
  "steel:pdf": "web",
  "prospects:research": "web",
  // Asking the founder.
  "approvals:request": "human",
  "approvals:create": "human",
};

/**
 * Toolsets every seat may use because they are the WRAPPER's own capabilities, which the app's
 * manifests do not model at all: the skills store, delegation, the cron table, plugins, MCP
 * servers, the founder prompt, vision and the shared brain. The capability differences between
 * seats live in {@link GATED_TOOLSETS}; these are the floor every seat stands on.
 */
export const SHARED_SEAT_TOOLSETS: readonly Toolset[] = ["skills", "delegation", "cron", "plugins", "mcp", "vision", "human", "memory"];

/** The toolsets a seat gets ONLY when its manifest names a capability that maps to one. */
export const GATED_TOOLSETS: readonly Toolset[] = ["file_ops", "terminal", "code", "web", "browser"];

/** One capability the seat's manifest names that this install cannot execute. */
export interface UnavailableCapability {
  readonly capability: string;
  readonly reason: string;
}

/** Everything that makes one seat different from the next. Derived; never hand-written. */
export interface SeatCapability {
  readonly seat: AgentRole;
  readonly name: string;
  /** Trent toolsets this seat may use, sorted. */
  readonly toolsets: readonly Toolset[];
  /** Gated toolsets this seat may NOT use: stricter than the floor, never looser. */
  readonly denied: readonly Toolset[];
  /** Manifest capabilities with no executor here, so nothing advertises what does not exist. */
  readonly unavailable: readonly UnavailableCapability[];
  /** The seat's approval gates from the manifest, on top of the absolute approval floors. */
  readonly approvalGates: readonly string[];
  /** `budgetCentsPerRun` from the manifest. INTEGER CENTS, never dollars. */
  readonly budgetCents: number;
  /** `modelTier` from the seat manifest; `orchestrator/model-env.ts` maps it onto a model. */
  readonly modelTier: SeatModelTier;
  /**
   * The id of this seat's eval suite. Goldens only (plan decision 4), so a seat's suite is built
   * from that seat's promoted goldens and is looked up by the seat id itself. D0/D1 own the
   * lookup; this field is what they look it up by.
   */
  readonly evalSuiteId: string;
}

const UNAVAILABLE_REASON = "no Trent toolset executes it in the CLI; it needs the hosted application and its provider credentials";

function build(seat: AgentRole): SeatCapability {
  const environment = SLOT_ENVIRONMENTS[seat];
  const manifest = SEAT_MANIFESTS[seat];
  const mapped = new Set<Toolset>();
  const unavailable: UnavailableCapability[] = [];
  for (const capability of environment.tools) {
    const toolset = CAPABILITY_TOOLSETS[capability];
    if (toolset === undefined) unavailable.push({ capability, reason: UNAVAILABLE_REASON });
    else mapped.add(toolset);
  }
  for (const toolset of SHARED_SEAT_TOOLSETS) mapped.add(toolset);
  return {
    seat,
    name: manifest.name,
    toolsets: [...mapped].sort(),
    denied: GATED_TOOLSETS.filter((toolset) => !mapped.has(toolset)),
    unavailable,
    approvalGates: [...environment.approvalRequiredFor],
    budgetCents: environment.budgetCentsPerRun,
    modelTier: manifest.modelTier,
    evalSuiteId: seat,
  };
}

/** Every seat the application defines, keyed by role. Computed once from the manifests. */
export const SEAT_CAPABILITIES: Readonly<Record<AgentRole, SeatCapability>> = Object.fromEntries(
  (Object.keys(SLOT_ENVIRONMENTS) as AgentRole[]).map((role) => [role, build(role)]),
) as Record<AgentRole, SeatCapability>;

/** True when the application defines this seat. */
export function isSeatRole(seat: string): seat is AgentRole {
  return Object.prototype.hasOwnProperty.call(SEAT_CAPABILITIES, seat);
}

/** The seat's capability record. An id the application does not define is a configuration error. */
export function seatCapability(seat: string): SeatCapability {
  if (!isSeatRole(seat)) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "fleet.seat",
      message: `The application defines no "${seat}" seat; the roster is ${Object.keys(SEAT_CAPABILITIES).join(", ")}`,
      target: seat,
    });
  }
  return SEAT_CAPABILITIES[seat];
}

/** The seat's toolsets intersected with the ones this install actually enabled and built. */
export function seatToolsets(seat: string, enabled: readonly string[]): Toolset[] {
  const allowed = new Set<string>(seatCapability(seat).toolsets);
  return enabled.filter((toolset): toolset is Toolset => allowed.has(toolset));
}
