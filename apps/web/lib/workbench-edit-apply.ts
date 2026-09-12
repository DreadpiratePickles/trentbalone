/**
 * workbench-edit-apply.ts
 *
 * Deterministic search/replace merge for workbench edit actions, with an
 * optional model-assisted fastApply fallback when blocks cannot be matched.
 */

import OpenAI from "openai";
import { MODELS, modelChatTuning } from "@/lib/ai-client";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EditBlock = {
  search: string;
  replace: string;
};

export type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; miss: string };

type FastApplyFn = (original: string, lazyEdit: string) => Promise<string>;

const APPLY_MODEL = MODELS.APPLY;

let fastApplyImpl: FastApplyFn | null = null;

/** Test hook — inject a mock fastApply implementation. */
export function setFastApplyImpl(fn: FastApplyFn | null): void {
  fastApplyImpl = fn;
}

// ── Block parsing ─────────────────────────────────────────────────────────────

const BLOCK_RE =
  /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;

export function parseEditBlocks(body: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(body)) !== null) {
    blocks.push({ search: match[1], replace: match[2] });
  }
  return blocks;
}

// ── Deterministic apply ───────────────────────────────────────────────────────

export function applyEditBlocks(original: string, blocks: EditBlock[]): ApplyResult {
  let current = original;
  for (const block of blocks) {
    const applied = applySingleBlock(current, block.search, block.replace);
    if (!applied.ok) return { ok: false, miss: block.search };
    current = applied.content;
  }
  return { ok: true, content: current };
}

function applySingleBlock(
  source: string,
  search: string,
  replace: string,
): { ok: true; content: string } | { ok: false } {
  const exact = replaceAt(source, search, replace);
  if (exact) return { ok: true, content: exact };

  const normalized = replaceNormalized(source, search, replace);
  if (normalized) return { ok: true, content: normalized };

  const anchored = replaceAnchored(source, search, replace);
  if (anchored) return { ok: true, content: anchored };

  return { ok: false };
}

function replaceAt(source: string, search: string, replace: string): string | null {
  const idx = source.indexOf(search);
  if (idx === -1) return null;
  return source.slice(0, idx) + replace + source.slice(idx + search.length);
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
}

function replaceNormalized(source: string, search: string, replace: string): string | null {
  const srcLines = normalizeLines(source);
  const searchLines = normalizeLines(search);
  const replaceLines = replace.split("\n");
  if (!searchLines.length) return null;

  for (let i = 0; i <= srcLines.length - searchLines.length; i++) {
    const slice = srcLines.slice(i, i + searchLines.length);
    if (slice.every((line, j) => line === searchLines[j])) {
      const merged = [...srcLines.slice(0, i), ...replaceLines, ...srcLines.slice(i + searchLines.length)];
      return merged.join("\n");
    }
  }
  return null;
}

function replaceAnchored(source: string, search: string, replace: string): string | null {
  const searchLines = normalizeLines(search).map((line) => line.trim());
  if (searchLines.length < +2) return null;

  const srcLines = source.replace(/\r\n/g, "\n").split("\n");
  const first = searchLines[0];
  const last = searchLines[searchLines.length - 1];
  const replaceLines = replace.split("\n");

  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i].trim() !== first) continue;
    for (let j = i + searchLines.length - 1; j < srcLines.length; j++) {
      if (srcLines[j].trim() !== last) continue;
      const block = srcLines.slice(i, j + 1).map((line) => line.trim());
      if (block.length !== searchLines.length) continue;
      if (!block.every((line, idx) => fuzzyLineMatch(line, searchLines[idx]))) continue;
      const merged = [...srcLines.slice(0, i), ...replaceLines, ...srcLines.slice(j + 1)];
      return merged.join("\n");
    }
  }
  return null;
}

function fuzzyLineMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  return collapse(actual) === collapse(expected);
}

// ── Model-assisted fallback ───────────────────────────────────────────────────

export async function fastApply(original: string, lazyEdit: string): Promise<string> {
  if (fastApplyImpl) return fastApplyImpl(original, lazyEdit);

  // fastApply is enabled by default when OPENAI_API_KEY is present.
  // Explicitly disable it with WORKBENCH_FAST_APPLY_ENABLED=false or =0.
  const disabled =
    process.env.WORKBENCH_FAST_APPLY_ENABLED === "false"
    || process.env.WORKBENCH_FAST_APPLY_ENABLED === "0";

  if (disabled) {
    throw new Error(
      "fastApply is disabled via WORKBENCH_FAST_APPLY_ENABLED=false.",
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("fastApply requires OPENAI_API_KEY.");
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 60_000,
  });

  const response = await client.chat.completions.create({
    model: APPLY_MODEL,
    ...modelChatTuning(APPLY_MODEL, 8192, 0),
    messages: [
      {
        role: "system",
        content:
          "You merge a lazy edit into an original file. Return ONLY the complete merged file content. " +
          "No markdown fences, no commentary.",
      },
      {
        role: "user",
        content: [
          "Original file:",
          "```",
          original,
          "```",
          "",
          "Lazy edit (search/replace blocks or partial file with markers):",
          "```",
          lazyEdit,
          "```",
        ].join("\n"),
      },
    ],
  });

  const merged = response.choices[0]?.message?.content?.trim();
  if (!merged) throw new Error("fastApply returned empty content.");
  return merged;
}
