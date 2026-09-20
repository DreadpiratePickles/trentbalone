/**
 * DOCX and XLSX to Markdown, on the ZIP reader and the XML reader alone. No `mammoth`, no
 * SheetJS: a contract needs its headings, paragraphs, lists and tables; a spreadsheet needs its
 * cell values in rows. Styling, images, comments, formulas and charts are not text and are not
 * extracted. What is not understood is dropped, never rendered as XML.
 */
import { openZip, type ZipArchive } from "./zip.js";
import { childElements, findElement, findElements, parseXml, textOf, type XmlNode } from "./xml.js";

/** A cell for a Markdown table: one line, pipes escaped, so the row stays one row. */
function tableCell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** Rows to a Markdown table with the first row as the header. Ragged rows are padded. */
export function renderTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, i) => tableCell(row[i] ?? "")).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function requirePart(archive: ZipArchive, name: string, kind: string): string {
  const bytes = archive.read(name);
  if (bytes === undefined) throw new Error(`not a ${kind}: the archive has no ${name}`);
  return bytes.toString("utf8");
}

function openOffice(bytes: Buffer, kind: string): ZipArchive {
  try {
    return openZip(bytes);
  } catch (err) {
    throw new Error(`not a ${kind}: ${(err as Error).message}`);
  }
}

// ── DOCX ──────────────────────────────────────────────────────────────────────────────────────

const HEADING_STYLE_RE = /^(?:heading|berschrift|titre|t[ií]tulo)\s*(\d)$/i;

function headingLevel(paragraph: XmlNode): number | undefined {
  const style = findElement(paragraph, "w:pStyle")?.attrs["w:val"] ?? "";
  if (/^title$/i.test(style)) return 1;
  const match = HEADING_STYLE_RE.exec(style);
  if (match === null) return undefined;
  const level = Number.parseInt(match[1]!, 10);
  return level >= 1 && level <= 6 ? level : undefined;
}

/** The run text of a paragraph: `w:t` text, tabs and breaks; tracked deletions are left out. */
function runText(node: XmlNode): string {
  let out = "";
  for (const child of node.children) {
    if (typeof child === "string") continue;
    switch (child.name) {
      case "w:t":
        out += textOf(child);
        break;
      case "w:tab":
        out += "\t";
        break;
      case "w:br":
      case "w:cr":
        out += "\n";
        break;
      case "w:del":
      case "w:delText":
      case "w:pPr":
      case "w:rPr":
      case "w:drawing":
      case "w:pict":
      case "w:tbl":
        break;
      default:
        out += runText(child);
    }
  }
  return out;
}

function listLevel(paragraph: XmlNode): number | undefined {
  const numbering = findElement(paragraph, "w:numPr");
  if (numbering === undefined) return undefined;
  const level = Number.parseInt(findElement(numbering, "w:ilvl")?.attrs["w:val"] ?? "0", 10);
  return Number.isFinite(level) ? Math.max(0, level) : 0;
}

function paragraphMarkdown(paragraph: XmlNode): string {
  const text = runText(paragraph).replace(/[ \t]+\n/g, "\n").trim();
  if (text === "") return "";
  const level = headingLevel(paragraph);
  if (level !== undefined) return `${"#".repeat(level)} ${text.replace(/\s+/g, " ")}`;
  const indent = listLevel(paragraph);
  if (indent !== undefined) return `${"  ".repeat(indent)}- ${text.replace(/\s*\n\s*/g, " ")}`;
  return text;
}

function cellText(cell: XmlNode): string {
  return childElements(cell)
    .map((child) => (child.name === "w:p" ? runText(child) : child.name === "w:tbl" ? findElements(child, "w:t").map(textOf).join(" ") : ""))
    .filter((part) => part.trim() !== "")
    .join(" ");
}

function tableMarkdown(table: XmlNode): string {
  const rows = childElements(table, "w:tr").map((row) => childElements(row, "w:tc").map(cellText));
  return renderTable(rows.filter((row) => row.length > 0));
}

/** Body children in order; content controls and structured blocks are walked through. */
function blocks(node: XmlNode, out: string[]): void {
  for (const child of childElements(node)) {
    if (child.name === "w:p") out.push(paragraphMarkdown(child));
    else if (child.name === "w:tbl") out.push(tableMarkdown(child));
    else if (child.name === "w:sdt" || child.name === "w:sdtContent" || child.name === "w:customXml") blocks(child, out);
  }
}

export interface DocxText {
  readonly markdown: string;
  /** The first level-1 heading, when the document has one. */
  readonly title?: string;
}

export function docxToMarkdown(bytes: Buffer): DocxText {
  const archive = openOffice(bytes, "DOCX");
  const document = parseXml(requirePart(archive, "word/document.xml", "DOCX"));
  const body = findElement(document, "w:body");
  if (body === undefined) throw new Error("not a DOCX: word/document.xml has no w:body");
  const parts: string[] = [];
  blocks(body, parts);
  const lines: string[] = [];
  for (const part of parts) {
    if (part === "") continue;
    // Consecutive list items stay one list; everything else is its own paragraph.
    const previous = lines[lines.length - 1];
    if (part.trimStart().startsWith("- ") && previous !== undefined && previous.trimStart().startsWith("- ")) lines[lines.length - 1] = `${previous}\n${part}`;
    else lines.push(part);
  }
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim();
  return { markdown: lines.join("\n\n"), ...(title === undefined ? {} : { title }) };
}

// ── XLSX ──────────────────────────────────────────────────────────────────────────────────────

export interface XlsxSheetText {
  readonly name: string;
  readonly markdown: string;
  readonly rows: number;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function sharedStrings(archive: ZipArchive): string[] {
  const raw = archive.read("xl/sharedStrings.xml");
  if (raw === undefined) return [];
  const sst = parseXml(raw.toString("utf8"));
  const root = findElement(sst, "sst") ?? sst;
  return childElements(root, "si").map((si) => findElements(si, "t").map(textOf).join(""));
}

function cellValue(cell: XmlNode, shared: readonly string[]): string {
  const type = cell.attrs.t ?? "n";
  const value = findElement(cell, "v");
  if (type === "s") {
    const index = Number.parseInt(value === undefined ? "" : textOf(value), 10);
    return shared[index] ?? "";
  }
  if (type === "inlineStr") {
    const inline = findElement(cell, "is");
    return inline === undefined ? "" : findElements(inline, "t").map(textOf).join("");
  }
  if (type === "b") return value !== undefined && textOf(value).trim() === "1" ? "TRUE" : "FALSE";
  return value === undefined ? "" : textOf(value).trim();
}

function sheetRows(xml: string, shared: readonly string[]): string[][] {
  const sheet = parseXml(xml);
  const data = findElement(sheet, "sheetData");
  if (data === undefined) return [];
  const grid: string[][] = [];
  childElements(data, "row").forEach((row, ordinal) => {
    const declared = Number.parseInt(row.attrs.r ?? "", 10);
    const r = Number.isFinite(declared) && declared > 0 ? declared - 1 : ordinal;
    const cells: string[] = grid[r] ?? [];
    childElements(row, "c").forEach((cell, position) => {
      const ref = cell.attrs.r ?? "";
      const c = ref === "" ? position : Math.max(0, columnIndex(ref));
      cells[c] = cellValue(cell, shared);
    });
    grid[r] = cells;
  });
  // Dense, rectangular, and trimmed: no trailing blank rows, every row as wide as the widest.
  const rows = grid.map((row) => Array.from(row, (cell) => cell ?? ""));
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === "")) rows.pop();
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}

export function xlsxToMarkdown(bytes: Buffer): XlsxSheetText[] {
  const archive = openOffice(bytes, "XLSX");
  const workbook = parseXml(requirePart(archive, "xl/workbook.xml", "XLSX"));
  const rels = parseXml(requirePart(archive, "xl/_rels/workbook.xml.rels", "XLSX"));
  const targets = new Map<string, string>();
  for (const rel of findElements(rels, "Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (id === undefined || target === undefined) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const shared = sharedStrings(archive);
  const out: XlsxSheetText[] = [];
  findElements(workbook, "sheet").forEach((sheet, ordinal) => {
    const name = sheet.attrs.name ?? `Sheet${String(ordinal + 1)}`;
    const part = targets.get(sheet.attrs["r:id"] ?? "") ?? `xl/worksheets/sheet${String(ordinal + 1)}.xml`;
    const xml = archive.read(part);
    const rows = xml === undefined ? [] : sheetRows(xml.toString("utf8"), shared);
    const table = renderTable(rows);
    out.push({ name, rows: rows.length, markdown: `## Sheet: ${name}\n\n${table === "" ? "(empty sheet)" : table}` });
  });
  if (out.length === 0) throw new Error("not an XLSX: the workbook names no sheets");
  return out;
}
