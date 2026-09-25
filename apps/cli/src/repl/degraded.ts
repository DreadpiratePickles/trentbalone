/**
 * 3.9 — the offline degraded banner.
 *
 * With no provider key the planner falls back to deterministic plans and the critic
 * auto-passes. Both are silent upstream, so the REPL says so loudly: once, before the
 * first turn, and again on every agent line for the rest of the session.
 *
 * A first launch with no key opens the REPL here rather than exiting (`../commands/index.ts`),
 * so the banner is also the newcomer's first-run guide: one paragraph that says what is missing,
 * what works without it, and the one command that fixes it. Every "works" item was run on a
 * keyless profile with no config (docs/sessions/2026-09-25-p2a2-first-run.md).
 *
 * Keys are tested for PRESENCE only. No key value is read into a message, logged, or
 * echoed anywhere — AGENTS.md invariant 7.
 */

import { PROVIDER_ENV_VARS } from "@trent/core/setup/detect.js";
import { GLYPHS, truncate, visibleWidth, type Theme } from "../ui/index.js";

/**
 * Every key name setup detects (`@trent/core/setup/detect.ts` is the source of truth), so a key
 * that `trent setup` accepted can never leave the REPL announcing that there is none.
 */
export const PROVIDER_KEY_VARS: readonly string[] = [...new Set(Object.values(PROVIDER_ENV_VARS).flat())];

/** The marker appended to every agent line while degraded. Mono uppercase, no emoji. */
export const DEGRADED_MARK = "DEGRADED";

export interface KeySource {
  [name: string]: string | undefined;
}

/** True when not one provider key is present. Never returns or logs a key. */
export function isDegraded(source: KeySource): boolean {
  return !PROVIDER_KEY_VARS.some((name) => (source[name] ?? "").trim() !== "");
}

const PARAGRAPH = [
  `${GLYPHS.needsApproval} DEGRADED MODE — no model provider key was found, so nothing typed here reaches a model:`,
  "an objective gets a deterministic fallback plan, the critic auto-passes, and the run fails when its model calls are refused.",
  "Without a key these still work: /help, trent doctor, trent config get|set, trent fleet list and trent brain status|log|show.",
  "To fix it, put a provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY; trent setup lists every one)",
  "in your shell or in the profile .env file, then run: trent setup",
].join(" ");

/** Word-wrap to `width`, continuation lines indented two columns. A word wider than a line is cut. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const indent = lines.length === 0 ? "" : "  ";
    const next = line === "" ? `${indent}${word}` : `${line} ${word}`;
    if (line === "" || visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    lines.push(line);
    line = `  ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => truncate(l, width));
}

/** The banner, in ember, because a human needs to notice it. */
export function renderDegradedBanner(theme: Theme, width: number): string[] {
  return wrap(PARAGRAPH, Math.max(1, Math.floor(width))).map((line) => theme.needsApproval(line));
}
