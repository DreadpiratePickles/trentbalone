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
import {
  createLocalRuntime,
  hasLocalModel,
  isLocalProvider,
  LOCAL_RUNTIME_LABEL,
  pullCommand,
  START_COMMAND,
  type LocalRuntimePort,
} from "@trent/core/setup/local-runtime.js";
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

/**
 * True when not one provider key is present. Never returns or logs a key.
 *
 * [L0-3] G7: DEGRADED means no usable provider, not no key. A local provider (`ollama`, `lmstudio`)
 * needs no key, so the key rule does not apply to it: its runtime decides, in `degradedState`.
 */
export function isDegraded(source: KeySource, provider?: string): boolean {
  if (isLocalProvider(provider)) return false;
  return !PROVIDER_KEY_VARS.some((name) => (source[name] ?? "").trim() !== "");
}

export interface DegradedState {
  readonly degraded: boolean;
  /** One line on why, when it is not a missing key: the local runtime is down or lacks the model. */
  readonly notice?: string;
}

export interface DegradedInput {
  source: KeySource;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** The local runtime; a test injects a fake `fetch`. Defaults to the real endpoints. */
  runtime?: LocalRuntimePort;
}

/**
 * [L0-3] G7. A hosted provider keeps the key rule and is never probed. A local one is usable when
 * its runtime answers at the gateway's own URL and lists the configured model; otherwise the REPL
 * says so in one line naming the URL and the command that fixes it (`ollama serve`, `ollama pull`).
 */
export async function degradedState(input: DegradedInput): Promise<DegradedState> {
  const { provider } = input;
  if (!isLocalProvider(provider)) return { degraded: isDegraded(input.source, provider) };
  const status = await (input.runtime ?? createLocalRuntime()).probe(provider, input.env ?? process.env);
  const label = LOCAL_RUNTIME_LABEL[provider];
  // Short enough that the Ollama line fits one 80-column terminal, the width a piped REPL gets.
  const lead = `${GLYPHS.needsApproval} DEGRADED — ${label}`;
  if (!status.reachable) {
    return { degraded: true, notice: `${lead} not answering at ${status.url}. Run: ${START_COMMAND[provider]}` };
  }
  const model = input.model?.trim() ?? "";
  if (model !== "" && !hasLocalModel(status.models, model)) {
    const pull = pullCommand(provider, model);
    return { degraded: true, notice: `${lead} at ${status.url} has no ${model}. ${pull === undefined ? `Load it in ${label}` : `Run: ${pull}`}` };
  }
  return { degraded: false };
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

/**
 * The banner, in ember, because a human needs to notice it. With a `notice` (a local runtime that is
 * down or lacks the model, [L0-3]) that one line replaces the no-key paragraph, which would be false.
 */
export function renderDegradedBanner(theme: Theme, width: number, notice?: string): string[] {
  return wrap(notice ?? PARAGRAPH, Math.max(1, Math.floor(width))).map((line) => theme.needsApproval(line));
}
