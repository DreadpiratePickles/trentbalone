/**
 * How any brain file becomes chunks with ids, and how an id finds its file again. This is the
 * one place both directions live, so `brain-index.ts` (which renders ids into a prompt) and
 * `brain_read` (which is handed one back) cannot drift apart.
 *
 *   docs/<slug>.md          id head `<slug>`             `lease#3`
 *   any other brain file    id head is the path itself   `decisions/2026-09-10-churn.md#1`
 *
 * A doc slug contains no `/` and no `.`, and every other head contains at least one of them, so
 * the two forms cannot collide. The title of a doc is its front matter; the title of any other
 * file is its first `#` line when it has one.
 */
import { BRAIN_DOCS_DIR } from "../brain.js";
import { chunkUnits, type ChunkOptions, type DocumentChunk } from "./chunk.js";
import { parseDocFile, type DocMeta } from "./doc-file.js";

export interface ChunkedBrainFile {
  readonly path: string;
  /** The id head every chunk of this file shares. */
  readonly head: string;
  /** A doc's front-matter title, a note's first heading, or `undefined` when there is neither. */
  readonly title?: string;
  readonly meta?: DocMeta;
  readonly chunks: readonly DocumentChunk[];
}

/** `docs/lease.md` is a doc; its slug is the id head. */
export function docSlugOf(relativePath: string): string | undefined {
  const prefix = `${BRAIN_DOCS_DIR}/`;
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(".md")) return undefined;
  const slug = relativePath.slice(prefix.length, -3);
  return slug !== "" && !slug.includes("/") ? slug : undefined;
}

export function chunkIdHead(relativePath: string): string {
  return docSlugOf(relativePath) ?? relativePath;
}

/** The brain-relative path an id head names. A bare slug is a doc; anything else is a path. */
export function pathForChunkHead(head: string): string {
  return head.includes("/") || head.includes(".") ? head : `${BRAIN_DOCS_DIR}/${head}.md`;
}

function firstHeading(text: string): string | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(text);
  return match?.[1]?.trim();
}

export function chunkBrainFile(relativePath: string, contents: string, options: ChunkOptions = {}): ChunkedBrainFile {
  const head = chunkIdHead(relativePath);
  if (docSlugOf(relativePath) !== undefined) {
    const parsed = parseDocFile(contents);
    const chunks = chunkUnits(head, parsed.units, options);
    const title = parsed.meta?.title ?? firstHeading(parsed.units.map((u) => u.text).join("\n"));
    return { path: relativePath, head, ...(title === undefined ? {} : { title }), ...(parsed.meta === undefined ? {} : { meta: parsed.meta }), chunks };
  }
  const title = firstHeading(contents);
  return { path: relativePath, head, ...(title === undefined ? {} : { title }), chunks: chunkUnits(head, [{ text: contents }], options) };
}
