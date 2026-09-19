/**
 * [D0] gate 1 — the frozen surface: the paths the self-improvement loop may never write.
 *
 * Design review section 6, item 1: nothing named the artifacts that GRADE the loop, so a loop
 * that could write files could raise its own score by editing the exam. Autoresearch and DGM both
 * carry an explicit do-not-modify list; this is ours, enforced by path rather than by intent:
 *
 *   suite              the bundled eval suites (`apps/web/.agents/skills/<skill>/evals/`) and the
 *                      wrapper's mechanical overlays
 *   golden             the goldens a failure capture wrote, and the promotion exemplars
 *   judge_prompt       `improve/judge.ts` and any prompt file beside it
 *   gate_code          `improve/`, `evals/` and `gepa/` — what executes, scores and selects
 *   read_only_memory   every configured block with `read_only: true`
 *   judge_input_memory every other configured block, because the judge's inputs are the outputs of
 *                      prompts those blocks are rendered into (`tools/memory/index.ts` puts every
 *                      block in the prelude), so a memory delta moves the grader
 *   configured         anything else the profile listed in `improve.frozen_paths`
 *
 * A draft whose write would land on one is refused with the path named, and the refusal is a
 * ledger row, so `trent improve history` shows what was attempted and why it was stopped.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLED_SKILLS_DIR } from "../fleet/SkillProvisioner.js";
import type { MemoryBlock } from "../tools/memory/blocks.js";
import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";
import { BUNDLED_MECHANICAL_OVERLAYS_DIR } from "./mechanical-overlay.js";
import { recordLedger } from "./ledger.js";

export type FrozenClass = "suite" | "golden" | "judge_prompt" | "gate_code" | "read_only_memory" | "judge_input_memory" | "configured";

/** Who the ledger says refused: the gate, by path, not a human and not the judge. */
export const FROZEN_REFUSAL_ACTOR = "gate:frozen_surface";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * This module ships as `src/improve/` in the repo and `dist/improve/` in the package, and both
 * are the gate code. Listing both means a check is right whichever one is loaded.
 */
function siblingDirs(name: string): string[] {
  const here = path.resolve(MODULE_DIR, "..", name);
  const source = path.resolve(MODULE_DIR, "../../src", name);
  return here === source ? [here] : [here, source];
}

export const GATE_CODE_DIRS: readonly string[] = [...siblingDirs("improve"), ...siblingDirs("evals"), ...siblingDirs("gepa")];

/** The judge's own prompt, and any prompt file kept beside it. */
export const JUDGE_PROMPT_FILES: readonly string[] = siblingDirs("improve").map((dir) => path.join(dir, "judge.ts"));
const JUDGE_PROMPT_DIRS: readonly string[] = siblingDirs("improve").map((dir) => path.join(dir, "prompts"));

export interface FrozenSurfaceOptions {
  /** Profile root: `<profileDir>/goldens`, `<profileDir>/exemplars` and `<profileDir>/memories` hang off it. */
  readonly profileDir: string;
  /** `config.memory.blocks`. A block with `read_only: true` is frozen; every other block is a judge input. */
  readonly blocks: readonly MemoryBlock[];
  /** Where a skill draft's bytes would be written, when the caller writes skills to disk at all. */
  readonly skillWriteRoot?: string;
  /** `config.improve.frozen_paths`. */
  readonly extraPaths?: readonly string[];
  /** Block labels the judge's inputs derive from. Defaults to every configured block. */
  readonly judgeInputBlocks?: readonly string[];
}

/** A write the loop wants to make: a file, or a named memory block. */
export type FrozenTarget = { readonly path: string; readonly memoryBlock?: undefined } | { readonly memoryBlock: string; readonly path?: undefined };

export interface FrozenViolation {
  readonly frozenClass: FrozenClass;
  /** The path or `block:<label>` that is frozen, named so a human can read the refusal. */
  readonly path: string;
  readonly reason: string;
}

export interface FrozenSurface {
  violationFor(target: FrozenTarget): FrozenViolation | undefined;
  /** The memory block labels this surface refuses, for a caller that wants to filter before it drafts. */
  readonly frozenBlocks: ReadonlyMap<string, FrozenClass>;
  readonly options: FrozenSurfaceOptions;
}

/** True when `file` is `root` or sits underneath it; `..` can never climb out of the comparison. */
function isUnder(file: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function firstRoot(file: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => isUnder(file, root));
}

export function createFrozenSurface(options: FrozenSurfaceOptions): FrozenSurface {
  const goldenRoots = [path.join(options.profileDir, "goldens"), path.join(options.profileDir, "exemplars")];
  // `skillWriteRoot` is not frozen in itself; it is frozen when it lands inside one of these.
  const suiteRoots = [BUNDLED_SKILLS_DIR, BUNDLED_MECHANICAL_OVERLAYS_DIR];
  const extra = [...(options.extraPaths ?? [])];
  const judgeInputs = new Set(options.judgeInputBlocks ?? options.blocks.map((b) => b.label));

  const frozenBlocks = new Map<string, FrozenClass>();
  for (const block of options.blocks) {
    if (block.read_only) frozenBlocks.set(block.label, "read_only_memory");
    else if (judgeInputs.has(block.label)) frozenBlocks.set(block.label, "judge_input_memory");
  }
  const blockFiles = new Map<string, { label: string; frozenClass: FrozenClass }>();
  for (const [label, frozenClass] of frozenBlocks) {
    const block = options.blocks.find((b) => b.label === label);
    if (block) blockFiles.set(path.resolve(options.profileDir, "memories", block.file), { label, frozenClass });
  }

  function reason(frozenClass: FrozenClass, what: string): string {
    return `${what} is frozen (${frozenClass}): the improvement loop may not write what grades it`;
  }

  return {
    frozenBlocks,
    options,
    violationFor(target) {
      if (target.memoryBlock !== undefined) {
        const frozenClass = frozenBlocks.get(target.memoryBlock);
        const named = `block:${target.memoryBlock}`;
        return frozenClass === undefined ? undefined : { frozenClass, path: named, reason: reason(frozenClass, named) };
      }
      const file = target.path;
      const byFile = blockFiles.get(path.resolve(file));
      if (byFile) return { frozenClass: byFile.frozenClass, path: file, reason: reason(byFile.frozenClass, file) };
      // Most specific first: the judge prompt is inside the gate code, and both are named classes.
      if (JUDGE_PROMPT_FILES.some((p) => path.resolve(p) === path.resolve(file)) || firstRoot(file, JUDGE_PROMPT_DIRS)) {
        return { frozenClass: "judge_prompt", path: file, reason: reason("judge_prompt", file) };
      }
      if (firstRoot(file, suiteRoots)) return { frozenClass: "suite", path: file, reason: reason("suite", file) };
      if (firstRoot(file, goldenRoots)) return { frozenClass: "golden", path: file, reason: reason("golden", file) };
      if (firstRoot(file, GATE_CODE_DIRS)) return { frozenClass: "gate_code", path: file, reason: reason("gate_code", file) };
      if (firstRoot(file, extra)) return { frozenClass: "configured", path: file, reason: reason("configured", file) };
      return undefined;
    },
  };
}

/**
 * What a draft would write. A skill draft writes one file under the caller's skill root (nothing
 * on disk when there is no root); a memory draft writes the blocks its payload carries, which is
 * why a memory delta is refused while every block is a judge input.
 */
export function draftTargets(draft: Pick<SkillDraftRow, "kind" | "taskType" | "content">, surface: FrozenSurface): FrozenTarget[] {
  if (draft.kind === "memory") {
    const labels = memoryDraftBlocks(draft.content);
    return [
      ...labels.map((memoryBlock) => ({ memoryBlock })),
      ...labels.flatMap((label) => {
        const block = surface.options.blocks.find((b) => b.label === label);
        return block ? [{ path: path.join(surface.options.profileDir, "memories", block.file) }] : [];
      }),
    ];
  }
  const root = surface.options.skillWriteRoot;
  if (draft.kind === "skill" && root !== undefined) return [{ path: path.join(root, draft.taskType, "SKILL.md") }];
  return [];
}

/** The block labels a memory draft's payload carries; an unreadable payload names none. */
function memoryDraftBlocks(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as { memory?: unknown; user?: unknown; blocks?: Array<{ label?: unknown }> };
    const labels: string[] = [];
    if (typeof parsed.memory === "string") labels.push("memory");
    if (typeof parsed.user === "string") labels.push("user");
    for (const block of parsed.blocks ?? []) if (typeof block.label === "string") labels.push(block.label);
    return labels;
  } catch {
    return [];
  }
}

/** Every violation a draft's targets produce, in target order and without duplicates. */
export function frozenViolations(draft: Pick<SkillDraftRow, "kind" | "taskType" | "content">, surface: FrozenSurface): FrozenViolation[] {
  const seen = new Set<string>();
  const out: FrozenViolation[] = [];
  for (const target of draftTargets(draft, surface)) {
    const violation = surface.violationFor(target);
    if (!violation || seen.has(violation.path)) continue;
    seen.add(violation.path);
    out.push(violation);
  }
  return out;
}

export function frozenRefusalMessage(violations: readonly FrozenViolation[]): string {
  return `refused: ${violations.map((v) => `${v.path} (${v.frozenClass})`).join("; ")}`;
}

/** The refusal itself: the draft is rejected and the ledger carries one row under the gate's name. */
export async function refuseFrozenDraft(
  store: ImproveStorePort,
  draft: SkillDraftRow,
  violations: readonly FrozenViolation[],
  now: string,
): Promise<SkillDraftRow> {
  const rejected = await store.updateDraft(draft.id, { status: "rejected", retiredAt: now });
  await recordLedger(store, { action: "reject", artifact: rejected, before: null, after: null, iterationId: null, actor: FROZEN_REFUSAL_ACTOR, now });
  return rejected;
}
