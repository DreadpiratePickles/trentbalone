/**
 * Hermes's `patch` matching chain (`tools/fuzzy_match.py:175-300`): precise strategies first,
 * similarity last, with the block-anchor thresholds 0.50 (one candidate) / 0.70 (several).
 * Approximate strategies are never used under `replace_all`.
 */

export type Span = readonly [start: number, end: number];

export interface FuzzyMatch {
  readonly strategy: string;
  readonly spans: readonly Span[];
}

function exact(content: string, pattern: string): Span[] {
  const spans: Span[] = [];
  if (!pattern) return spans;
  let from = 0;
  for (;;) {
    const at = content.indexOf(pattern, from);
    if (at === -1) return spans;
    spans.push([at, at + pattern.length]);
    from = at + pattern.length;
  }
}

/** Line offsets so a window of lines maps back to character spans of the ORIGINAL content. */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

function windowSpans(content: string, n: number, accept: (i: number, lines: string[]) => boolean): Span[] {
  const lines = content.split("\n");
  const starts = lineStarts(content);
  const spans: Span[] = [];
  for (let i = 0; i + n <= lines.length; i += 1) {
    if (!accept(i, lines)) continue;
    const end = i + n - 1;
    spans.push([starts[i]!, starts[end]! + lines[end]!.length]);
    i += n - 1;
  }
  return spans;
}

function transformedLines(content: string, pattern: string, transform: (line: string) => string): Span[] {
  const patternLines = pattern.split("\n").map(transform);
  const n = patternLines.length;
  return windowSpans(content, n, (i, lines) => patternLines.every((p, k) => transform(lines[i + k]!) === p));
}

function stripBoundary(content: string, pattern: string): Span[] {
  const patternLines = pattern.split("\n");
  const n = patternLines.length;
  const norm = (line: string, k: number): string => (k === 0 || k === n - 1 ? line.trim() : line);
  return windowSpans(content, n, (i, lines) => patternLines.every((p, k) => norm(lines[i + k]!, k) === norm(p, k)));
}

/** difflib.SequenceMatcher.ratio(): 2*M/T over the longest-common-subsequence of characters. */
function ratio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  return (2 * prev[b.length]!) / (a.length + b.length);
}

function blockAnchor(content: string, pattern: string): Span[] {
  const patternLines = pattern.split("\n");
  const n = patternLines.length;
  if (n < 2) return [];
  const first = patternLines[0]!.trim();
  const last = patternLines[n - 1]!.trim();
  const lines = content.split("\n");
  const candidates: number[] = [];
  for (let i = 0; i + n <= lines.length; i += 1) {
    if (lines[i]!.trim() === first && lines[i + n - 1]!.trim() === last) candidates.push(i);
  }
  const threshold = candidates.length === 1 ? 0.5 : 0.7;
  const middle = patternLines.slice(1, -1).join("\n");
  const set = new Set(candidates);
  return windowSpans(content, n, (i, ls) => set.has(i) && (n <= 2 || ratio(ls.slice(i + 1, i + n - 1).join("\n"), middle) >= threshold));
}

function contextAware(content: string, pattern: string): Span[] {
  const patternLines = pattern.split("\n");
  const n = patternLines.length;
  const sim = (a: string, b: string): number => (a === b ? 1 : ratio(a, b));
  return windowSpans(content, n, (i, lines) => {
    const block = lines.slice(i, i + n);
    if (sim(patternLines[0]!.trim(), block[0]!.trim()) < 0.8) return false;
    if (sim(patternLines[n - 1]!.trim(), block[n - 1]!.trim()) < 0.8) return false;
    return patternLines.every((p, k) => !p.trim() || sim(p.trim(), block[k]!.trim()) >= 0.8);
  });
}

const STRATEGIES: ReadonlyArray<readonly [string, (content: string, pattern: string) => Span[]]> = [
  ["exact", exact],
  ["line_trimmed", (c, p) => transformedLines(c, p, (l) => l.trim())],
  ["whitespace_normalized", (c, p) => transformedLines(c, p, (l) => l.replace(/[ \t]+/g, " ").trim())],
  ["indentation_flexible", (c, p) => transformedLines(c, p, (l) => l.replace(/^[ \t]+/, ""))],
  ["escape_normalized", (c, p) => {
    const unescaped = p.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
    return unescaped === p ? [] : exact(c, unescaped);
  }],
  ["trimmed_boundary", stripBoundary],
  ["unicode_normalized", (c, p) => {
    const nc = c.normalize("NFKC");
    const np = p.normalize("NFKC");
    return nc === c && np === p ? [] : exact(nc, np);
  }],
  ["block_anchor", blockAnchor],
  ["context_aware", contextAware],
];
const APPROXIMATE = new Set(["block_anchor", "context_aware"]);

/** First strategy with a match wins; approximate strategies are skipped under replace_all. */
export function fuzzyFind(content: string, pattern: string, replaceAll: boolean): FuzzyMatch | undefined {
  for (const [strategy, find] of STRATEGIES) {
    if (replaceAll && APPROXIMATE.has(strategy)) continue;
    const spans = find(content, pattern);
    if (spans.length) return { strategy, spans };
  }
  return undefined;
}

export function applySpans(content: string, spans: readonly Span[], replacement: string): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += content.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + content.slice(cursor);
}

/** A unified diff of one search/replace: the touched line range with three lines of context. */
export function unifiedDiff(display: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const from = Math.max(0, head - context);
  const aEnd = Math.min(a.length, a.length - tail + context);
  const bEnd = Math.min(b.length, b.length - tail + context);
  const lines = [`--- a/${display}`, `+++ b/${display}`, `@@ -${from + 1},${aEnd - from} +${from + 1},${bEnd - from} @@`];
  for (let i = from; i < head; i += 1) lines.push(` ${a[i]}`);
  for (let i = head; i < a.length - tail; i += 1) lines.push(`-${a[i]}`);
  for (let i = head; i < b.length - tail; i += 1) lines.push(`+${b[i]}`);
  for (let i = a.length - tail; i < aEnd; i += 1) lines.push(` ${a[i]}`);
  return lines.join("\n");
}
