/**
 * Builders for the binary fixtures the ingest suites need: a multi-page PDF, a DOCX and an XLSX.
 * Generated in code rather than committed as blobs so a reader can see exactly what each file
 * holds and a test can vary the content. Only test files import this module.
 */
import { deflateRawSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored-or-deflated ZIP archive from `{ path: contents }`, the container DOCX and XLSX share. */
export function buildZip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const deflated = deflateRawSync(raw);
    const stored = deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface DocxParagraph {
  readonly text: string;
  /** 1-6 renders the Word `Heading<n>` style; omitted is body text. */
  readonly heading?: number;
}

/** A DOCX with the given paragraphs and, optionally, one table after them. */
export function buildDocx(paragraphs: readonly DocxParagraph[], table?: readonly (readonly string[])[]): Buffer {
  const body = paragraphs
    .map((p) => {
      const style = p.heading === undefined ? "" : `<w:pPr><w:pStyle w:val="Heading${String(p.heading)}"/></w:pPr>`;
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const rows = (table ?? [])
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
    .join("");
  const tbl = table === undefined ? "" : `<w:tbl>${rows}</w:tbl>`;
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${tbl}<w:sectPr/></w:body></w:document>`;
  return buildZip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": document,
  });
}

export interface XlsxSheet {
  readonly name: string;
  /** Rows of cells; a string cell goes through the shared-strings table, a number is written inline. */
  readonly rows: readonly (readonly (string | number)[])[];
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** An XLSX with one worksheet per entry, strings in `sharedStrings.xml` the way Excel writes them. */
export function buildXlsx(sheets: readonly XlsxSheet[]): Buffer {
  const shared: string[] = [];
  const sharedIndex = (text: string): number => {
    const at = shared.indexOf(text);
    if (at !== -1) return at;
    shared.push(text);
    return shared.length - 1;
  };
  const files: Record<string, string> = {};
  const sheetXml = sheets.map((sheet, s) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${columnLetters(c)}${String(r + 1)}`;
            return typeof value === "number"
              ? `<c r="${ref}"><v>${String(value)}</v></c>`
              : `<c r="${ref}" t="s"><v>${String(sharedIndex(value))}</v></c>`;
          })
          .join("");
        return `<row r="${String(r + 1)}">${cells}</row>`;
      })
      .join("");
    return {
      part: `xl/worksheets/sheet${String(s + 1)}.xml`,
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rows}</sheetData></worksheet>`,
    };
  });
  sheetXml.forEach((entry) => {
    files[entry.part] = entry.xml;
  });
  files["xl/workbook.xml"] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets.map((sheet, s) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(s + 1)}" r:id="rId${String(s + 1)}"/>`).join("")}</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_sheet, s) =>
          `<Relationship Id="rId${String(s + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(s + 1)}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${String(sheets.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";
  files["xl/sharedStrings.xml"] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(shared.length)}" uniqueCount="${String(shared.length)}">` +
    shared.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("") +
    "</sst>";
  files["[Content_Types].xml"] =
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
  files["_rels/.rels"] =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  return buildZip(files);
}

const escapePdfText = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * A valid, uncompressed PDF 1.4 with one page per entry, each entry's lines set in Helvetica
 * from the top-left margin. Small enough to read in a hex dump and real enough for any parser.
 */
export function buildPdf(pages: readonly (readonly string[])[]): Buffer {
  const objects: (string | null)[] = [];
  const add = (body: string | null): number => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesNode = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageNumbers: number[] = [];
  for (const lines of pages) {
    const content = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL", ...lines.map((line, i) => `${i === 0 ? "" : "T* "}(${escapePdfText(line)}) Tj`), "ET"].join("\n");
    const stream = add(`<< /Length ${String(Buffer.byteLength(content, "latin1"))} >>\nstream\n${content}\nendstream`);
    pageNumbers.push(
      add(`<< /Type /Page /Parent ${String(pagesNode)} 0 R /MediaBox [0 0 612 792] /Contents ${String(stream)} 0 R /Resources << /Font << /F1 ${String(font)} 0 R >> >> >>`),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesNode)} 0 R >>`;
  objects[pagesNode - 1] = `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${String(n)} 0 R`).join(" ")}] /Count ${String(pageNumbers.length)} >>`;

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${String(i + 1)} 0 obj\n${body ?? ""}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
