import type { Artifact } from "@/lib/types";
import { ARTIFACT_TYPE_META } from "@/lib/artifacts";

type Sheet = {
  name: string;
  rows: Array<Array<string | number | boolean | null | undefined>>;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 54;
const TOP = 738;
const LINE_HEIGHT = 14;
const MAX_CHARS = 92;
const MAX_LINES_PER_PAGE = 48;

export function artifactToPdf(artifact: Artifact): Buffer {
  const lines = layoutPdfLines(artifact);
  const pages = chunk(lines, MAX_LINES_PER_PAGE);
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const pageLines of pages) {
    const content = buildPageContent(pageLines);
    const contentId = add(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const header = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  let body = header;
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "utf8");
}

export function artifactToXlsx(artifact: Artifact): Buffer {
  const sheets = artifactToSheets(artifact);
  const files: Array<{ path: string; content: string }> = [
    { path: "[Content_Types].xml", content: contentTypesXml(sheets.length) },
    { path: "_rels/.rels", content: rootRelsXml() },
    { path: "xl/workbook.xml", content: workbookXml(sheets) },
    { path: "xl/_rels/workbook.xml.rels", content: workbookRelsXml(sheets.length) },
    { path: "xl/styles.xml", content: stylesXml() },
    ...sheets.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      content: worksheetXml(sheet.rows)
    }))
  ];

  return zipStore(files.map((file) => ({
    name: file.path,
    data: Buffer.from(file.content, "utf8")
  })));
}

function layoutPdfLines(artifact: Artifact): Array<{ text: string; size: number }> {
  const lines: Array<{ text: string; size: number }> = [
    { text: artifact.title, size: 18 },
    { text: `${ARTIFACT_TYPE_META[artifact.type].label} | ${artifact.status} | ${artifact.createdAt}`, size: 9 },
    { text: "", size: 11 }
  ];

  for (const raw of artifact.content.split("\n")) {
    const trimmed = raw.trimEnd();
    if (!trimmed) {
      lines.push({ text: "", size: 11 });
      continue;
    }
    if (trimmed.startsWith("# ")) {
      lines.push({ text: trimmed.slice(2), size: 16 });
      continue;
    }
    if (trimmed.startsWith("## ")) {
      lines.push({ text: trimmed.slice(3), size: 13 });
      continue;
    }

    const prefix = trimmed.startsWith("- ") ? "- " : "";
    const body = prefix ? trimmed.slice(2) : trimmed;
    wrapText(body, MAX_CHARS - prefix.length).forEach((line, index) => {
      lines.push({ text: `${index === 0 ? prefix : "  "}${line}`, size: 10 });
    });
  }

  return lines;
}

function buildPageContent(lines: Array<{ text: string; size: number }>): string {
  const commands = ["BT", `${LEFT} ${TOP} Td`];
  let currentSize = 10;
  commands.push(`/F1 ${currentSize} Tf`);
  for (const line of lines) {
    if (line.size !== currentSize) {
      currentSize = line.size;
      commands.push(`/F1 ${currentSize} Tf`);
    }
    commands.push(`(${escapePdf(line.text)}) Tj`);
    commands.push(`0 -${LINE_HEIGHT} Td`);
  }
  commands.push("ET");
  return commands.join("\n");
}

function artifactToSheets(artifact: Artifact): Sheet[] {
  const bullets = artifact.content
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  const sections = artifact.content
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));

  return [
    {
      name: "Summary",
      rows: [
        ["Field", "Value"],
        ["Title", artifact.title],
        ["Type", ARTIFACT_TYPE_META[artifact.type].label],
        ["Status", artifact.status],
        ["Export format", artifact.exportFormat],
        ["Created by", artifact.createdByAgent],
        ["Summary", artifact.summary],
        ["Prompt", artifact.provenance.prompt],
        ["Generated at", artifact.provenance.generatedAt],
      ]
    },
    {
      name: "Actions",
      rows: [
        ["#", "Action"],
        ...bullets.map((bullet, index) => [index + 1, bullet])
      ]
    },
    {
      name: "Sources",
      rows: [
        ["#", "Source"],
        ...artifact.provenance.sources.map((source, index) => [index + 1, source])
      ]
    },
    {
      name: "Content",
      rows: [
        ["#", "Section"],
        ...sections.map((section, index) => [index + 1, section]),
        [],
        ["Raw content"],
        ...artifact.content.split("\n").map((line) => [line])
      ]
    }
  ];
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets}
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbookXml(sheets: Sheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((sheet, index) => `<sheet name="${xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}
</sheets>
</workbook>`;
}

function workbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Inter"/></font><font><b/><sz val="11"/><name val="Inter"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;
}

function worksheetXml(rows: Sheet["rows"]): string {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex + 1)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? " s=\"1\"" : "";
      if (typeof value === "number") {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      if (typeof value === "boolean") {
        return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlText(String(value ?? ""))}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="4" width="80" customWidth="1"/></cols>
<sheetData>${body}</sheetData>
</worksheet>`;
}

function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, file.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + file.data.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks.length ? chunks : [[]];
}

function escapePdf(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll("\"", "&quot;");
}

function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
