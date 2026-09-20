/**
 * One file in, Markdown units out. The format is decided by the extension and nothing else: a
 * file this module does not know is refused with its extension named and is never read as text,
 * because a PDF decoded as UTF-8 is not a document, it is noise that looks like one.
 *
 *   md, txt   as they are (line endings normalised); a Markdown file's first `#` line is its title
 *   csv       one Markdown table (RFC 4180 quoting: quoted commas, quoted newlines, doubled quotes)
 *   docx      headings, paragraphs, lists and tables (`office.ts`), one unit
 *   xlsx      one unit per sheet, each a Markdown table under `## Sheet: <name>` (`office.ts`)
 *   pdf       one unit per page (`extract-pdf.ts`); a page with no text layer is flagged
 *
 * Every extractor is local and deterministic; nothing here calls a model (principle 12).
 */
import fs from "node:fs";
import path from "node:path";

import type { DocumentUnit } from "./chunk.js";
import { resolvePdfExtractor, type PdfBacking, type PdfExtractor, type PdfExtractorOptions } from "./extract-pdf.js";
import { docxToMarkdown, renderTable, xlsxToMarkdown } from "./office.js";

export type DocumentFormat = "md" | "txt" | "csv" | "pdf" | "docx" | "xlsx";

const FORMATS: Readonly<Record<string, DocumentFormat>> = {
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
  ".csv": "csv",
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
};

/** The extensions `trent brain import` accepts, for a usage line or a doctor line. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(FORMATS);

export function formatOf(filePath: string): DocumentFormat | undefined {
  return FORMATS[path.extname(filePath).toLowerCase()];
}

export interface ExtractedDocument {
  readonly format: DocumentFormat;
  readonly title: string;
  readonly units: readonly DocumentUnit[];
  readonly pages?: number;
  readonly sheets?: readonly string[];
  /** What was not extracted and why, one line each; never a body. */
  readonly warnings: readonly string[];
}

export interface ExtractOptions extends PdfExtractorOptions {
  /** A resolved PDF extractor, `null` to run with none; resolved from the machine when omitted. */
  readonly pdf?: PdfExtractor | null;
}

/** `meeting_notes-2026.txt` reads as "meeting notes 2026": the file name as a title. */
export function titleFromFileName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  const words = stem.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  return words === "" ? stem : words;
}

function normaliseText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function firstHeading(markdown: string): string | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return match?.[1]?.trim();
}

/** RFC 4180: fields separated by commas, quoted with `"`, a quote doubled inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = normaliseText(text);
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ExtractorAvailability {
  /** Which PDF extractor would run, or `missing` when neither can be found. */
  readonly pdf: PdfBacking | "missing";
  readonly docx: "builtin";
  readonly xlsx: "builtin";
}

/** What `trent brain import` can read on this machine; the doctor prints it as one line. */
export async function extractorAvailability(options: PdfExtractorOptions = {}): Promise<ExtractorAvailability> {
  const pdf = await resolvePdfExtractor(options);
  return { pdf: pdf?.backing ?? "missing", docx: "builtin", xlsx: "builtin" };
}

export async function extractDocument(filePath: string, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const format = formatOf(filePath);
  if (format === undefined) {
    throw new Error(`unsupported file type "${path.extname(filePath) || "(no extension)"}": trent brain import reads ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  const bytes = fs.readFileSync(filePath);
  const fileTitle = titleFromFileName(filePath);

  switch (format) {
    case "md": {
      const text = normaliseText(bytes.toString("utf8"));
      return { format, title: firstHeading(text) ?? fileTitle, units: [{ text }], warnings: [] };
    }
    case "txt":
      return { format, title: fileTitle, units: [{ text: normaliseText(bytes.toString("utf8")) }], warnings: [] };
    case "csv": {
      const rows = parseCsv(bytes.toString("utf8"));
      return { format, title: fileTitle, units: [{ text: renderTable(rows) }], warnings: rows.length === 0 ? ["the file has no rows"] : [] };
    }
    case "docx": {
      const docx = docxToMarkdown(bytes);
      return { format, title: docx.title ?? fileTitle, units: [{ text: docx.markdown }], warnings: docx.markdown === "" ? ["the document has no text"] : [] };
    }
    case "xlsx": {
      const sheets = xlsxToMarkdown(bytes);
      return {
        format,
        title: fileTitle,
        units: sheets.map((sheet) => ({ text: sheet.markdown, sheet: sheet.name })),
        sheets: sheets.map((sheet) => sheet.name),
        warnings: sheets.filter((sheet) => sheet.rows === 0).map((sheet) => `sheet "${sheet.name}" is empty`),
      };
    }
    case "pdf": {
      const extractor = options.pdf === undefined ? await resolvePdfExtractor(options) : options.pdf;
      if (extractor === null || extractor === undefined) {
        throw new Error("no PDF extractor is available: install poppler (pdftotext) or the pdfjs-dist package; `trent doctor` reports which one is in use");
      }
      const pages = await extractor.extract(filePath, bytes);
      const warnings = pages.flatMap((text, i) => (text.trim() === "" ? [`page ${String(i + 1)} has no text layer (a scan needs OCR, which this import does not do)`] : []));
      const units = pages.map((text, i) => ({ text, page: i + 1 }));
      return { format, title: fileTitle, units, pages: pages.length, warnings };
    }
  }
}
