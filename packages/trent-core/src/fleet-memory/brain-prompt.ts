/**
 * [C2] The brain as a prompt block: `system/` in full (under the per-block limits) and the file
 * tree as SIGNPOSTS — paths only, bounded.
 *
 * Letta's context repositories and OpenClaw's memory both land on the same shape and for the same
 * reason: an always-loaded directory small enough to carry every turn, and a tree that tells the
 * model what exists without paying for it. The bodies of `memory/`, `decisions/` and `seats/` are
 * deliberately absent — a seat that needs one calls `brain_read` with the path it can see here, or
 * finds it through `fleet_search`. OpenClaw's own figure for the cost of getting this wrong is
 * about 24 tokens per indexed artifact in the system prompt; an unbounded tree is how that becomes
 * the whole context window.
 *
 * Everything here is deterministic: sorted paths, a fixed header, content read straight from disk.
 * The block sits in the STABLE tier, whose bytes are asserted equal across two runs of an
 * unchanged profile, so nothing objective-dependent, seat-dependent or clock-dependent may enter.
 */
import {
  BRAIN_DECISIONS_DIR,
  BRAIN_MEMORY_DIR,
  BRAIN_SEATS_DIR,
  BRAIN_SKILLS_INDEX,
  BRAIN_SYSTEM_DIR,
  BRAIN_SYSTEM_LIMIT_CHARS,
  type Brain,
} from "./brain.js";

/** How many paths the tree may name. Beyond it the block says how many it did not list. */
export const BRAIN_TREE_MAX_ENTRIES = 60;

export const BRAIN_BLOCK_HEADING =
  "## Brain (the company's own repository; files are the truth for identity, standing decisions and " +
  "episodic notes). It is ADVISORY: AGENTS.md, the workspace context files and config.yaml are normative.";

const TREE_HEADING =
  '### Files (paths only; brain_read {"path": "<path>"} reads one, fleet_search finds text across runs)';

export interface BrainBlockOptions {
  readonly brain: Brain;
  /**
   * File names under `system/` that another STABLE block already carries verbatim — the migrated
   * memory blocks, which the company-memory block renders with their labels, descriptions and
   * caps. Listing them here is what stops the same bytes being paid for twice.
   */
  readonly excludeSystemFiles?: readonly string[];
  /** Cap on ONE system file's rendered bytes. Defaults to the `memory` block's own cap. */
  readonly systemLimitChars?: number;
  readonly treeMaxEntries?: number;
}

/** Clip to `limit`, marking the cut so a reader never mistakes a truncation for the whole file. */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 3))}...`;
}

/** The directories whose bodies stay out of the prompt, in the order the tree lists them. */
const TREE_DIRS: readonly string[] = [BRAIN_SYSTEM_DIR, BRAIN_MEMORY_DIR, BRAIN_DECISIONS_DIR, BRAIN_SEATS_DIR];

export function renderBrainBlock(options: BrainBlockOptions): string {
  const { brain } = options;
  const status = brain.status();
  if (!status.exists) return "";

  const limit = options.systemLimitChars ?? BRAIN_SYSTEM_LIMIT_CHARS;
  const excluded = new Set((options.excludeSystemFiles ?? []).map((f) => f.toLowerCase()));
  const all = brain.tree();

  const sections: string[] = [BRAIN_BLOCK_HEADING];

  for (const rel of all) {
    if (!rel.startsWith(`${BRAIN_SYSTEM_DIR}/`)) continue;
    const name = rel.slice(BRAIN_SYSTEM_DIR.length + 1);
    if (name.startsWith(".") || excluded.has(name.toLowerCase())) continue;
    const body = (brain.readFile(rel) ?? "").trim();
    if (body === "") continue;
    sections.push(`### ${rel}\n${clip(body, limit)}`);
  }

  const maxEntries = options.treeMaxEntries ?? BRAIN_TREE_MAX_ENTRIES;
  const listable = all.filter(
    (rel) => rel === BRAIN_SKILLS_INDEX || TREE_DIRS.some((dir) => rel.startsWith(`${dir}/`)),
  ).filter((rel) => !rel.split("/").some((part) => part.startsWith(".")));

  // Newest first WITHIN each directory would make the tier unstable the moment a file is added,
  // so the order is the same sorted order the walk produced and the cut is from the end.
  const shown = listable.slice(0, Math.max(0, maxEntries));
  const omitted = listable.length - shown.length;
  const treeLines = [TREE_HEADING, ...shown];
  if (omitted > 0) treeLines.push(`(${String(omitted)} more file(s) not listed; fleet_search finds them by content)`);
  sections.push(treeLines.join("\n"));

  return sections.join("\n\n");
}
