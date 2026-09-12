/**
 * Repo map — a compact, relevance-ranked skeleton of a workspace so the build
 * agent stops "editing blind". For each file we extract exported symbols, build
 * an import reference graph, rank files with personalized PageRank (seeded by the
 * files in play), and render a token-budgeted `path → symbols` skeleton.
 *
 * Pure + deterministic: no provider I/O lives here, which keeps it unit-testable
 * offline. The caller (buildProjectContext) fetches file contents and feeds them in.
 *
 * Inspired by Aider's tree-sitter + PageRank repo map; this is the regex MVP the
 * blueprint (for-cursor/workbench-competitive-upgrade-blueprint.md P1-2) calls for.
 */

export type RepoFile = { path: string; content: string };
export type SymbolMap = Record<string, string[]>;
export type ReferenceGraph = Record<string, string[]>;

const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const INDEX_BASENAMES = SOURCE_EXT.map((ext) => `index${ext}`);

/** Rough token estimate (~4 chars/token) — good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract top-level exported symbol names from a TS/JS source file. */
export function extractExports(content: string): string[] {
  const found: Array<{ name: string; at: number }> = [];
  const collect = (re: RegExp, map: (m: RegExpMatchArray) => string | undefined) => {
    for (const m of content.matchAll(re)) {
      const name = map(m);
      if (name && m.index !== undefined) found.push({ name, at: m.index });
    }
  };

  // export default ...
  collect(/^\s*export\s+default\b/gm, () => "default");
  // export [async] function NAME / export function* NAME
  collect(/^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, (m) => m[1]);
  // export const|let|var NAME
  collect(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m) => m[1]);
  // export [abstract] class NAME
  collect(/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m) => m[1]);
  // export type NAME / export interface NAME / export enum NAME
  collect(/^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm, (m) => m[1]);
  // export { a, b as c } — capture the exported (aliased) names, preserving order
  for (const block of content.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    const baseAt = block.index ?? 0;
    let cursor = 0;
    for (const entry of block[1].split(",")) {
      const piece = entry.trim();
      const at = baseAt + block[0].indexOf(entry, cursor);
      cursor += entry.length + 1;
      if (!piece) continue;
      const asMatch = piece.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch ? asMatch[1] : piece.split(/\s+/)[0];
      if (name && name !== "default") found.push({ name, at });
    }
  }

  found.sort((a, b) => a.at - b.at);
  const names: string[] = [];
  for (const { name } of found) if (!names.includes(name)) names.push(name);
  return names;
}

export function buildSymbolMap(files: RepoFile[]): SymbolMap {
  const map: SymbolMap = {};
  for (const file of files) map[file.path] = extractExports(file.content);
  return map;
}

/** All import/export-from/dynamic-import/require specifiers in a source file. */
function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from "y"
    /\bimport\s*['"]([^'"]+)['"]/g, // import "y" (side-effect)
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // export { x } from "y"
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import("y")
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require("y")
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Resolve an import specifier to an in-repo file path, or undefined if it is a
 * bare/node_modules import or cannot be resolved. Handles relative paths and the
 * `@/` root alias, trying source extensions and `/index` variants.
 */
function resolveSpecifier(spec: string, fromPath: string, known: Set<string>): string | undefined {
  let base: string | undefined;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    base = normalizePath(`${dirname(fromPath)}/${spec}`);
  } else if (spec.startsWith("@/")) {
    base = normalizePath(spec.slice(2));
  } else if (spec.startsWith("/")) {
    base = normalizePath(spec);
  } else {
    return undefined; // bare import (npm dependency)
  }

  const candidates = [
    base,
    ...SOURCE_EXT.map((ext) => `${base}${ext}`),
    ...INDEX_BASENAMES.map((name) => `${base}/${name}`),
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/** path → list of in-repo file paths it imports (deduped, self-refs dropped). */
export function buildReferenceGraph(files: RepoFile[]): ReferenceGraph {
  const known = new Set(files.map((f) => f.path));
  const graph: ReferenceGraph = {};
  for (const file of files) {
    const targets = new Set<string>();
    for (const spec of importSpecifiers(file.content)) {
      const resolved = resolveSpecifier(spec, file.path, known);
      if (resolved && resolved !== file.path) targets.add(resolved);
    }
    graph[file.path] = [...targets];
  }
  return graph;
}

/**
 * Personalized PageRank over the import graph. Edge A→B (A imports B) flows rank
 * into B, so referenced files outrank unreferenced ones. When `seeds` are given,
 * teleport mass concentrates on them, biasing toward their neighborhood.
 * Returns paths ordered most→least relevant (stable on ties).
 */
export function rankFiles(
  files: RepoFile[],
  opts: { seeds?: string[]; graph?: ReferenceGraph; damping?: number; iterations?: number } = {},
): string[] {
  const paths = files.map((f) => f.path);
  const n = paths.length;
  if (n === 0) return [];

  const graph = opts.graph ?? buildReferenceGraph(files);
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 40;
  const index = new Map(paths.map((p, i) => [p, i]));

  const validSeeds = (opts.seeds ?? []).filter((s) => index.has(s));
  const teleport = new Array<number>(n).fill(0);
  if (validSeeds.length > 0) {
    for (const seed of validSeeds) teleport[index.get(seed)!] = 1 / validSeeds.length;
  } else {
    teleport.fill(1 / n);
  }

  const outLinks: number[][] = paths.map((p) =>
    (graph[p] ?? []).map((t) => index.get(t)).filter((i): i is number => i !== undefined),
  );

  let rank = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array<number>(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const links = outLinks[i];
      if (links.length === 0) {
        dangling += rank[i];
        continue;
      }
      const share = rank[i] / links.length;
      for (const j of links) next[j] += share;
    }
    for (let i = 0; i < n; i++) {
      // (1-d)*teleport + d*(incoming flow + redistributed dangling mass via teleport)
      next[i] = (1 - damping) * teleport[i] + damping * (next[i] + dangling * teleport[i]);
    }
    rank = next;
  }

  return paths
    .map((path, i) => ({ path, score: rank[i], order: i }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map((entry) => entry.path);
}

/**
 * Render a token-budgeted `path — symbols` skeleton, highest-ranked files first.
 * Files that would overflow the budget are dropped (lowest relevance first).
 */
export function renderRepoMap(
  files: RepoFile[],
  opts: { seeds?: string[]; tokenBudget?: number } = {},
): string {
  if (files.length === 0) return "";
  const budget = opts.tokenBudget ?? 1200;
  const graph = buildReferenceGraph(files);
  const symbols = buildSymbolMap(files);
  const ranked = rankFiles(files, { seeds: opts.seeds, graph });

  const lines: string[] = [];
  for (const path of ranked) {
    const syms = symbols[path] ?? [];
    const line = syms.length ? `${path} — ${syms.join(", ")}` : `${path} — (no exports)`;
    const candidate = lines.length ? `${lines.join("\n")}\n${line}` : line;
    if (estimateTokens(candidate) > budget) break;
    lines.push(line);
  }
  return lines.join("\n");
}
