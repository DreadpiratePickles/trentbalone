/**
 * 3.3 — the streaming render loop.
 *
 * Orchestrator events in, transcript lines out. Each agent line is `● [Name] title...`
 * where the DOT carries the state colour and the NAME carries the category colour —
 * except that state outranks identity, so a step awaiting a human renders entirely in
 * ember. All colour comes from the ui theme; this module writes no escape of its own.
 */

import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { GLYPHS, type AgentCategory, type AgentState, type Theme } from "../ui/index.js";
import { DEGRADED_MARK } from "./degraded.js";

export interface AgentIdentity {
  role: string;
  displayName: string;
  category: AgentCategory;
}

/**
 * Catalog role ids are `<division>-<seat>` (`eng-ai-engineer`) or a bare seat (`ceo`).
 * The division prefixes and the seat keywords both route to one of the thirteen
 * categories the style contract defines; anything unrecognised takes the neutral
 * category rather than borrowing a colour that would then mean two things.
 */
const DIVISION: Record<string, AgentCategory> = {
  eng: "engineering",
  engineering: "engineering",
  prod: "product",
  product: "product",
  des: "design",
  design: "design",
  mkt: "marketing",
  marketing: "marketing",
  ads: "paid-media",
  paid: "paid-media",
  sales: "sales",
  fin: "finance",
  finance: "finance",
  pm: "project-management",
  ops: "project-management",
  exec: "project-management",
  qa: "testing",
  test: "testing",
  testing: "testing",
  sup: "support",
  support: "support",
  edu: "academic",
  academic: "academic",
  research: "academic",
  xr: "spatial-computing",
  spatial: "spatial-computing",
};

/** Seats with no division prefix. `ceo` coordinates the fleet, so it reads as coordination. */
const BARE_SEAT: Record<string, AgentCategory> = {
  ceo: "project-management",
  planner: "project-management",
  critic: "testing",
  consolidator: "project-management",
};

const ACRONYM = new Set(["ai", "ml", "ux", "ui", "qa", "seo", "api", "sre", "ceo", "cto", "cfo"]);

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part !== "")
    .map((part) => (ACRONYM.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

export function identityForRole(role: string): AgentIdentity {
  const slug = role.trim().toLowerCase();
  const bare = BARE_SEAT[slug];
  if (bare !== undefined) return { role, displayName: titleCase(slug), category: bare };

  const [prefix, ...rest] = slug.split("-");
  const division = prefix === undefined ? undefined : DIVISION[prefix];
  if (division !== undefined && rest.length > 0) {
    return { role, displayName: titleCase(rest.join("-")), category: division };
  }
  const whole = DIVISION[slug];
  if (whole !== undefined) return { role, displayName: titleCase(slug), category: whole };
  return { role, displayName: titleCase(slug), category: "specialized" };
}

// ── line construction ───────────────────────────────────────────────────────

export interface RenderOptions {
  theme: Theme;
  /** Marks every agent line, so deterministic fallback output can never pass for model output. */
  degraded?: boolean;
}

interface LiveStep {
  identity: AgentIdentity;
  title: string;
}

const IDLE_DOT = GLYPHS.idle;

export class TranscriptRenderer {
  readonly #theme: Theme;
  readonly #degraded: boolean;
  readonly #steps = new Map<string, LiveStep>();
  readonly #awaiting = new Set<string>();
  readonly #lines: string[] = [];

  constructor(options: RenderOptions) {
    this.#theme = options.theme;
    this.#degraded = options.degraded ?? false;
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  /** An agent line. The dot takes the state colour; the name takes the category colour. */
  agentLine(identity: AgentIdentity, state: AgentState, text: string): string {
    const label = this.#theme.agentLabel(`[${identity.displayName}]`, identity.category, state);
    // Body text stays mist even here: the signal colour lives on the dot and the name,
    // and the contract forbids one element carrying two meanings.
    const suffix = this.#degraded ? ` ${this.#theme.meta(DEGRADED_MARK)}` : "";
    return `${label} ${this.#theme.body(text)}${suffix}`;
  }

  #note(glyph: string, text: string): string {
    return `${this.#theme.meta(glyph)} ${this.#theme.body(text)}`;
  }

  #step(event: OrcEvent): LiveStep {
    const id = event.step?.id ?? "unknown";
    const known = this.#steps.get(id);
    const identity = event.step?.agentRole === undefined ? known?.identity : identityForRole(event.step.agentRole);
    const live: LiveStep = {
      identity: identity ?? identityForRole("specialized"),
      title: event.step?.title ?? known?.title ?? "Working",
    };
    this.#steps.set(id, live);
    return live;
  }

  /** Appends a line the REPL itself produced (an interrupt notice, a budget alert). */
  push(line: string): string {
    this.#lines.push(line);
    return line;
  }

  /** Handles one event and returns the lines it newly emitted (often none). */
  handle(event: OrcEvent): string[] {
    const emitted = this.#linesFor(event);
    this.#lines.push(...emitted);
    return emitted;
  }

  #linesFor(event: OrcEvent): string[] {
    switch (event.kind) {
      case "run_start":
        return [this.#note(IDLE_DOT, `Objective: ${event.run?.objective ?? "(none)"}`)];
      case "run_preflight":
        return [this.#note(IDLE_DOT, event.detail ?? "Preflight")];
      case "plan_start":
        return [this.#note(IDLE_DOT, "Planning...")];
      case "plan_end":
        return [this.#note(IDLE_DOT, "Plan ready")];
      case "step_pending": {
        const step = this.#step(event);
        return [this.agentLine(step.identity, "idle", `${step.title} queued`)];
      }
      case "step_start": {
        this.#awaiting.delete(event.step?.id ?? "unknown");
        const step = this.#step(event);
        return [this.agentLine(step.identity, "running", `${step.title}...`)];
      }
      case "step_output": {
        // The step's output is printed HERE and only here. step_critic carries the same
        // `step.output`, so reading it there printed every output twice (live proof, F6).
        const detail = event.detail ?? event.step?.output;
        return detail === undefined || detail === "" ? [] : [`    ${this.#theme.body(detail)}`];
      }
      case "step_note":
      case "step_critic": {
        const detail = event.detail;
        return detail === undefined || detail === "" ? [] : [`    ${this.#theme.body(detail)}`];
      }
      case "step_awaiting_approval":
      case "run_awaiting_approval": {
        // One gate, two bus events (step_ then run_awaiting_approval): the line is drawn once.
        const id = event.step?.id ?? "unknown";
        if (this.#awaiting.has(id)) return [];
        this.#awaiting.add(id);
        const step = this.#step(event);
        return [this.agentLine(step.identity, "needsApproval", `${step.title} — awaiting your approval`)];
      }
      case "step_approved": {
        this.#awaiting.delete(event.step?.id ?? "unknown");
        const step = this.#step(event);
        return [this.agentLine(step.identity, "running", `${step.title}...`)];
      }
      case "step_end": {
        this.#awaiting.delete(event.step?.id ?? "unknown");
        const step = this.#step(event);
        const failed = event.step?.status === "failed";
        return [this.agentLine(step.identity, failed ? "failed" : "done", step.title)];
      }
      case "step_blocked": {
        const step = this.#step(event);
        return [this.agentLine(step.identity, "failed", `${step.title} blocked${detailSuffix(event)}`)];
      }
      case "consolidate_start":
        return [this.#note(IDLE_DOT, "Consolidating...")];
      case "consolidate_end":
        return [this.#note(IDLE_DOT, "Consolidated")];
      case "run_done":
        return [`${this.#theme.success(GLYPHS.done)} ${this.#theme.success("Run complete")}`];
      case "run_failed":
        return [`${this.#theme.error(GLYPHS.failed)} ${this.#theme.error(`Run failed${detailSuffix(event)}`)}`];
      case "run_cancelled":
        return [this.#note(IDLE_DOT, "Run cancelled")];
      case "heartbeat":
        return [];
      default:
        return [];
    }
  }
}

function detailSuffix(event: OrcEvent): string {
  return event.detail === undefined || event.detail === "" ? "" : `: ${event.detail}`;
}

/** Convenience for tests and for replaying a persisted run. */
export function renderTranscript(events: readonly OrcEvent[], options: RenderOptions): string[] {
  const renderer = new TranscriptRenderer(options);
  for (const event of events) renderer.handle(event);
  return [...renderer.lines];
}
