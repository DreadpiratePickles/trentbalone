/**
 * The chunker: Markdown in, bounded chunks out, each with a stable id and its place in the
 * document. Pure text; no file, no clock, no model (rulebook principle 12: an LLM pass per chunk
 * is a later, measured decision, not this one).
 *
 * Boundaries, in order of strength:
 *   1. A UNIT — a PDF page, a spreadsheet sheet — is never crossed. That is what lets a citation
 *      name the page: `lease#7 #p3` is page 3 or it is nothing.
 *   2. A HEADING starts a new section. A section that fits the bound is one chunk; a heading with
 *      no body of its own is folded into the section that follows it, so a lone title line is
 *      never a chunk.
 *   3. Inside a section, paragraphs are packed up to the bound; a paragraph longer than the bound
 *      is cut at line, then word, boundaries. Consecutive chunks of one section OVERLAP by the tail
 *      of the previous chunk from its first whole word, so a sentence cut in two is whole in one.
 *   4. A Markdown table split across chunks repeats its header row, so a row chunk says what its
 *      columns are.
 *
 * Ids are `<head>#<n>` with `n` counting from 1 across the whole document: the same text yields
 * the same ids, so an id in a seat's brief a month ago still names the same bytes today unless the
 * document itself changed, which the index's version key already accounts for.
 */

export const DEFAULT_CHUNK_CHARS = 1_200;
export const DEFAULT_CHUNK_OVERLAP = 150;

/** One extractor output unit: the whole file, or one page, or one sheet. */
export interface DocumentUnit {
  readonly text: string;
  readonly page?: number;
  readonly sheet?: string;
}

export interface DocumentChunk {
  /** `<head>#<n>`; the head is the doc slug or the brain-relative path. */
  readonly id: string;
  readonly n: number;
  readonly text: string;
  /** The heading breadcrumb above the chunk (`Handbook > Refunds`); absent before any heading. */
  readonly heading?: string;
  readonly page?: number;
  readonly sheet?: string;
}

export interface ChunkOptions {
  readonly maxChars?: number;
  readonly overlapChars?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(```|~~~)/;
const TABLE_SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

interface Section {
  readonly heading?: string;
  readonly text: string;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Heading-delimited sections, with fences respected and empty headings folded forward. */
function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const stack: string[] = [];
  const sections: Section[] = [];
  let pending: string[] = [];
  let pendingHeading: string | undefined;
  let hasBody = false;
  let inFence = false;

  const flush = (): void => {
    if (pending.length === 0) return;
    const body = pending.join("\n").trim();
    if (body !== "") sections.push({ ...(pendingHeading === undefined ? {} : { heading: pendingHeading }), text: body });
    pending = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING_RE.exec(line);
    if (match === null) {
      pending.push(line);
      if (line.trim() !== "") hasBody = true;
      continue;
    }
    const level = match[1]!.length;
    const title = match[2]!.trim();
    // A heading with no body since the last heading rides into the next section unbroken.
    if (hasBody) flush();
    stack.length = Math.min(stack.length, level - 1);
    while (stack.length < level - 1) stack.push(stack[stack.length - 1] ?? title);
    stack[level - 1] = title;
    pendingHeading = stack.filter((part, i, all) => i === 0 || part !== all[i - 1]).join(" > ");
    pending.push(line);
    hasBody = false;
  }
  flush();
  return sections;
}

interface Piece {
  readonly text: string;
  /** For a table row: the header and separator lines that make the row readable on its own. */
  readonly tableHeader?: string;
}

/** `[head, rest]`: `text` cut once at the last word boundary inside `room`, or hard at `room`. */
function cutOnce(text: string, room: number): [string, string] {
  if (text.length <= room) return [text, ""];
  const window = text.slice(0, room);
  const at = window.lastIndexOf(" ");
  const cut = at > room / 2 ? at : room;
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

/** Paragraphs, with an oversized Markdown table broken into rows that each remember the header. */
function splitPieces(text: string, maxChars: number): Piece[] {
  const pieces: Piece[] = [];
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed === "") continue;
    const lines = trimmed.split("\n");
    const isTable = trimmed.length > maxChars && lines.length > 2 && lines[0]!.trimStart().startsWith("|") && TABLE_SEPARATOR_RE.test(lines[1]!);
    if (!isTable) {
      pieces.push({ text: trimmed });
      continue;
    }
    const header = `${lines[0]}\n${lines[1]}`;
    for (const line of lines.slice(2)) if (line.trim() !== "") pieces.push({ text: line.trim(), tableHeader: header });
  }
  return pieces;
}

/** The tail of `text` from its first whole word within the last `overlap` characters. */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return "";
  const tail = text.slice(-overlap);
  const at = tail.search(/\s/);
  return at === -1 ? "" : tail.slice(at).trim();
}

/** The smallest room worth filling before a chunk is closed instead. */
const MIN_FILL_CHARS = 40;

/**
 * Pack one section's pieces into chunks of at most `maxChars`. A piece that does not fit closes
 * the chunk; a piece longer than a chunk fills the room and continues into the next, joined to
 * the overlap by a space so the cut sentence reads whole there.
 */
function packSection(section: Section, maxChars: number, overlap: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentHeader: string | undefined;
  /** True while `current` holds nothing but the overlap carried from the previous chunk. */
  let fresh = true;

  const close = (carryOverlap: boolean): void => {
    if (current === "") return;
    chunks.push(current);
    current = carryOverlap ? overlapTail(current, overlap) : "";
    currentHeader = undefined;
    fresh = true;
  };

  for (const piece of splitPieces(section.text, maxChars)) {
    const isRow = piece.tableHeader !== undefined;
    let text = piece.text;
    let continuation = false;
    while (text !== "") {
      const needsHeader = isRow && piece.tableHeader !== currentHeader;
      const prefix = needsHeader ? `${piece.tableHeader}\n` : "";
      const separator = current === "" ? "" : continuation && fresh ? " " : isRow && !needsHeader ? "\n" : "\n\n";
      const addition = `${separator}${prefix}${text}`;
      if (current.length + addition.length <= maxChars) {
        current += addition;
        if (isRow) currentHeader = piece.tableHeader;
        fresh = false;
        text = "";
        continue;
      }
      const wholeFitsFresh = prefix.length + text.length <= maxChars;
      const room = maxChars - current.length - separator.length - prefix.length;
      if (!fresh) {
        // A piece that fits a fresh chunk goes there whole; an oversized one fills the room here
        // unless the room is too small to be worth a fragment, so a heading is never left alone.
        if (wholeFitsFresh || room < Math.floor(maxChars / 4)) {
          close(!isRow);
          continue;
        }
      } else if (current !== "" && ((wholeFitsFresh && !continuation) || room < MIN_FILL_CHARS)) {
        // The carried overlap is worth less than a whole new paragraph, or leaves no room at all.
        // A continuation keeps it: the overlap is what makes the cut sentence whole here.
        current = "";
        currentHeader = undefined;
        continue;
      }
      const [head, rest] = room < MIN_FILL_CHARS ? cutOnce(`${prefix}${text}`, maxChars) : cutOnce(text, room);
      current += room < MIN_FILL_CHARS ? head : `${separator}${prefix}${head}`;
      if (isRow) currentHeader = piece.tableHeader;
      close(!isRow);
      text = rest;
      continuation = true;
    }
  }
  if (current !== "" && !fresh) chunks.push(current);
  return chunks;
}

/** Chunk every unit in order; ids count across units so a document has one sequence. */
export function chunkUnits(head: string, units: readonly DocumentUnit[], options: ChunkOptions = {}): DocumentChunk[] {
  const maxChars = Math.max(200, Math.trunc(options.maxChars ?? DEFAULT_CHUNK_CHARS));
  const overlap = Math.min(Math.max(0, Math.trunc(options.overlapChars ?? DEFAULT_CHUNK_OVERLAP)), Math.floor(maxChars / 3));
  const out: DocumentChunk[] = [];
  for (const unit of units) {
    const text = normalise(unit.text);
    if (text === "") continue;
    for (const section of splitSections(text)) {
      for (const body of packSection(section, maxChars, overlap)) {
        const n = out.length + 1;
        out.push({
          id: `${head}#${String(n)}`,
          n,
          text: body,
          ...(section.heading === undefined ? {} : { heading: section.heading }),
          ...(unit.page === undefined ? {} : { page: unit.page }),
          ...(unit.sheet === undefined ? {} : { sheet: unit.sheet }),
        });
      }
    }
  }
  return out;
}

export function chunkMarkdown(head: string, markdown: string, options: ChunkOptions = {}): DocumentChunk[] {
  return chunkUnits(head, [{ text: markdown }], options);
}

/** A sheet name as a tag token: lowercase, hyphenated, bounded. */
export function sheetSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug === "" ? "sheet" : slug;
}

/** `#p3` for a page, `#sheet:<slug>` for a sheet, "" for a chunk with neither. */
export function locationTag(chunk: Pick<DocumentChunk, "page" | "sheet">): string {
  if (chunk.page !== undefined) return `#p${String(chunk.page)}`;
  if (chunk.sheet !== undefined) return `#sheet:${sheetSlug(chunk.sheet)}`;
  return "";
}

/** `<head>#<n>` with `n` a positive integer; anything else is not a chunk id. */
export function parseChunkId(id: string): { head: string; n: number } | undefined {
  const match = /^(.+)#([1-9][0-9]*)$/.exec(id.trim());
  if (match === null) return undefined;
  return { head: match[1]!, n: Number.parseInt(match[2]!, 10) };
}
