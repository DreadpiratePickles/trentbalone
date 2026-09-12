/**
 * 3.9 — the offline degraded banner.
 *
 * With no provider key the planner falls back to deterministic plans and the critic
 * auto-passes. Both are silent upstream, so the REPL says so loudly: once, before the
 * first turn, and again on every agent line for the rest of the session.
 *
 * Keys are tested for PRESENCE only. No key value is read into a message, logged, or
 * echoed anywhere — AGENTS.md invariant 7.
 */

import { GLYPHS, truncate, type Theme } from "../ui/index.js";

/** The env vars the model gateway maps its providers onto. */
export const PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** The marker appended to every agent line while degraded. Mono uppercase, no emoji. */
export const DEGRADED_MARK = "DEGRADED";

export interface KeySource {
  [name: string]: string | undefined;
}

/** True when not one provider key is present. Never returns or logs a key. */
export function isDegraded(source: KeySource): boolean {
  return !PROVIDER_KEY_VARS.some((name) => (source[name] ?? "").trim() !== "");
}

const BODY = [
  `${GLYPHS.needsApproval} DEGRADED MODE — no provider key is configured.`,
  "  Plans are deterministic fallbacks and the critic auto-passes.",
  "  Nothing below is real model output. Run `trent doctor` to fix it.",
];

/** The banner, in ember, because a human needs to notice it. */
export function renderDegradedBanner(theme: Theme, width: number): string[] {
  return BODY.map((line) => theme.needsApproval(truncate(line, Math.max(1, Math.floor(width)))));
}
