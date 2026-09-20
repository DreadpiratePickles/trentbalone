/**
 * The on-disk shape of an imported document: `brain/docs/<slug>.md`, a YAML front matter block
 * and then the Markdown, with page and sheet boundaries kept as HTML comments so the file can be
 * re-chunked identically without the original. The file is the truth; the chunk index is derived
 * from it and disposable (`brain-index.ts`).
 *
 *   ---
 *   title: Office lease
 *   source: /Users/founder/Documents/lease.pdf
 *   format: pdf
 *   sha256: <hex of the source bytes>
 *   imported_at: 2026-09-20T10:00:00.000Z
 *   pages: 3
 *   provenance: founder-import
 *   ---
 *   <!-- trent:page 1 -->
 *   ...
 *
 * `provenance: founder-import` names what this is: company-held, externally authored. The recall
 * block says the same in one line, so a sentence inside a vendor's contract is data to a seat,
 * never an instruction.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { DocumentUnit } from "./chunk.js";
import type { DocumentFormat } from "./extract.js";

export const DOC_PROVENANCE = "founder-import";

export interface DocMeta {
  readonly title: string;
  /** The absolute path the document was imported from. */
  readonly source: string;
  readonly format: DocumentFormat;
  readonly sha256: string;
  readonly imported_at: string;
  readonly pages?: number;
  readonly sheets?: readonly string[];
  readonly provenance: typeof DOC_PROVENANCE;
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PAGE_MARKER_RE = /^<!-- trent:page (\d+) -->$/;
const SHEET_MARKER_RE = /^<!-- trent:sheet (.*) -->$/;

function marker(unit: DocumentUnit): string | undefined {
  if (unit.page !== undefined) return `<!-- trent:page ${String(unit.page)} -->`;
  if (unit.sheet !== undefined) return `<!-- trent:sheet ${unit.sheet.replace(/-->/g, "").trim()} -->`;
  return undefined;
}

export function renderDocFile(meta: DocMeta, units: readonly DocumentUnit[]): string {
  const front = stringifyYaml({
    title: meta.title,
    source: meta.source,
    format: meta.format,
    sha256: meta.sha256,
    imported_at: meta.imported_at,
    ...(meta.pages === undefined ? {} : { pages: meta.pages }),
    ...(meta.sheets === undefined ? {} : { sheets: [...meta.sheets] }),
    provenance: meta.provenance,
  }, { lineWidth: 0 });
  const body = units
    .map((unit) => {
      const head = marker(unit);
      const text = unit.text.trim();
      return head === undefined ? text : `${head}\n${text}`;
    })
    .join("\n\n");
  return `---\n${front.trimEnd()}\n---\n${body}\n`;
}

export interface ParsedDocFile {
  readonly meta?: DocMeta;
  readonly units: readonly DocumentUnit[];
}

function asMeta(raw: unknown): DocMeta | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  // A digest of digits alone parses as a YAML number; it is still the digest.
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : typeof value.sha256 === "number" ? String(value.sha256) : undefined;
  if (typeof value.title !== "string" || typeof value.source !== "string" || sha256 === undefined) return undefined;
  const sheets = Array.isArray(value.sheets) ? value.sheets.filter((s): s is string => typeof s === "string") : undefined;
  return {
    title: value.title,
    source: value.source,
    format: (typeof value.format === "string" ? value.format : "md") as DocumentFormat,
    sha256,
    imported_at: value.imported_at instanceof Date ? value.imported_at.toISOString() : String(value.imported_at ?? ""),
    ...(typeof value.pages === "number" ? { pages: value.pages } : {}),
    ...(sheets === undefined ? {} : { sheets }),
    provenance: DOC_PROVENANCE,
  };
}

/** Front matter (when present and well formed) and the units the markers delimit. */
export function parseDocFile(contents: string): ParsedDocFile {
  const text = contents.replace(/\r\n?/g, "\n");
  const match = FRONT_MATTER_RE.exec(text);
  let meta: DocMeta | undefined;
  let body = text;
  if (match !== null) {
    try {
      meta = asMeta(parseYaml(match[1]!));
    } catch {
      meta = undefined;
    }
    body = text.slice(match[0].length);
  }
  const units: DocumentUnit[] = [];
  let current: { page?: number; sheet?: string; lines: string[] } = { lines: [] };
  const flush = (): void => {
    const unitText = current.lines.join("\n").trim();
    if (unitText !== "") {
      units.push({
        text: unitText,
        ...(current.page === undefined ? {} : { page: current.page }),
        ...(current.sheet === undefined ? {} : { sheet: current.sheet }),
      });
    }
  };
  for (const line of body.split("\n")) {
    const page = PAGE_MARKER_RE.exec(line);
    const sheet = page === null ? SHEET_MARKER_RE.exec(line) : null;
    if (page === null && sheet === null) {
      current.lines.push(line);
      continue;
    }
    flush();
    current = page !== null ? { page: Number.parseInt(page[1]!, 10), lines: [] } : { sheet: sheet![1]!.trim(), lines: [] };
  }
  flush();
  return { ...(meta === undefined ? {} : { meta }), units };
}
