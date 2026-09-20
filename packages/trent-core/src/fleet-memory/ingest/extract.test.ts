/**
 * The extractors: every supported format becomes Markdown units, and nothing else is ever read as
 * text. Markdown, text and CSV need no parser; DOCX and XLSX are ZIP-packed XML read with
 * `node:zlib` alone; PDF goes through `pdftotext` when it is on PATH and `pdfjs-dist` otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractDocument, extractorAvailability, formatOf } from "./extract.js";
import { buildDocx, buildPdf, buildXlsx, buildZip } from "./test-fixtures.js";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-extract-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe("formatOf", () => {
  it("recognises the six formats by extension, case-insensitively, and nothing else", () => {
    expect(formatOf("a/notes.md")).toBe("md");
    expect(formatOf("a/notes.MD")).toBe("md");
    expect(formatOf("a/notes.markdown")).toBe("md");
    expect(formatOf("a/notes.txt")).toBe("txt");
    expect(formatOf("a/rows.csv")).toBe("csv");
    expect(formatOf("a/lease.pdf")).toBe("pdf");
    expect(formatOf("a/lease.docx")).toBe("docx");
    expect(formatOf("a/numbers.xlsx")).toBe("xlsx");
    expect(formatOf("a/photo.png")).toBeUndefined();
    expect(formatOf("a/lease.doc")).toBeUndefined();
    expect(formatOf("a/noext")).toBeUndefined();
  });
});

describe("extractDocument", () => {
  it("takes Markdown as-is, with the first heading as the title", async () => {
    const file = write("handbook.md", "# Staff handbook\n\nWelcome.\n");
    const doc = await extractDocument(file);
    expect(doc.format).toBe("md");
    expect(doc.title).toBe("Staff handbook");
    expect(doc.units).toHaveLength(1);
    expect(doc.units[0]!.text).toBe("# Staff handbook\n\nWelcome.");
  });

  it("takes plain text as one unit titled after the file", async () => {
    const file = write("meeting_notes-2026.txt", "We agreed on Tuesday.\r\nNext step: invoice.\r\n");
    const doc = await extractDocument(file);
    expect(doc.format).toBe("txt");
    expect(doc.title).toBe("meeting notes 2026");
    expect(doc.units[0]!.text).toBe("We agreed on Tuesday.\nNext step: invoice.");
  });

  it("renders CSV as a Markdown table, honouring quoted commas and escaping pipes", async () => {
    const file = write("customers.csv", 'name,plan,note\n"Acme, Inc",pro,"has a | in it"\nBeta,free,""\n');
    const doc = await extractDocument(file);
    expect(doc.format).toBe("csv");
    expect(doc.units[0]!.text.split("\n")).toEqual([
      "| name | plan | note |",
      "| --- | --- | --- |",
      "| Acme, Inc | pro | has a \\| in it |",
      "| Beta | free |  |",
    ]);
  });

  it("refuses a format it does not know without reading the bytes as text", async () => {
    const file = write("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(extractDocument(file)).rejects.toThrow(/\.png/);
  });

  it("turns a DOCX into Markdown with headings, paragraphs and a table", async () => {
    const file = write(
      "contract.docx",
      buildDocx(
        [
          { text: "Service agreement", heading: 1 },
          { text: "This agreement is between Acme & Beta." },
          { text: "Payment terms", heading: 2 },
          { text: "Invoices are due in thirty days." },
        ],
        [
          ["Item", "Price"],
          ["Setup", "500"],
        ],
      ),
    );
    const doc = await extractDocument(file);
    expect(doc.format).toBe("docx");
    expect(doc.title).toBe("Service agreement");
    const text = doc.units[0]!.text;
    expect(text).toContain("# Service agreement");
    expect(text).toContain("This agreement is between Acme & Beta.");
    expect(text).toContain("## Payment terms");
    expect(text).toContain("Invoices are due in thirty days.");
    expect(text).toContain("| Item | Price |");
    expect(text).toContain("| Setup | 500 |");
    expect(text).not.toContain("<w:");
  });

  it("turns a two-sheet XLSX into two Markdown tables, one unit per sheet", async () => {
    const file = write(
      "numbers.xlsx",
      buildXlsx([
        { name: "Costs", rows: [["item", "amount"], ["rent", 2400], ["power", 310]] },
        { name: "Revenue", rows: [["month", "total"], ["January", 9100]] },
      ]),
    );
    const doc = await extractDocument(file);
    expect(doc.format).toBe("xlsx");
    expect(doc.sheets).toEqual(["Costs", "Revenue"]);
    expect(doc.units.map((u) => u.sheet)).toEqual(["Costs", "Revenue"]);
    expect(doc.units[0]!.text).toContain("| item | amount |");
    expect(doc.units[0]!.text).toContain("| rent | 2400 |");
    expect(doc.units[1]!.text).toContain("| January | 9100 |");
    expect(doc.units[1]!.text).not.toContain("rent");
  });

  it("refuses a ZIP that is not the office document it claims to be", async () => {
    const file = write("odd.docx", buildZip({ "readme.txt": "not a document" }));
    await expect(extractDocument(file)).rejects.toThrow(/word\/document\.xml/);
  });

  it("extracts a three-page PDF as three page units", async () => {
    const file = write(
      "lease.pdf",
      buildPdf([
        ["Office lease agreement", "The parties and the premises are described here."],
        ["Rent", "The monthly rent is 2,400 dollars, payable on the first."],
        ["Termination", "Either party may end this agreement with ninety days written notice."],
      ]),
    );
    const doc = await extractDocument(file);
    expect(doc.format).toBe("pdf");
    expect(doc.pages).toBe(3);
    expect(doc.units.map((u) => u.page)).toEqual([1, 2, 3]);
    expect(doc.units[0]!.text).toContain("Office lease agreement");
    expect(doc.units[1]!.text).toContain("2,400 dollars");
    expect(doc.units[2]!.text).toContain("ninety days written notice");
    expect(doc.warnings).toEqual([]);
  });

  it("flags a PDF page with no text layer instead of inventing text for it", async () => {
    const file = write("scan.pdf", buildPdf([["Cover page"], [], ["Back page"]]));
    const doc = await extractDocument(file);
    expect(doc.pages).toBe(3);
    expect(doc.warnings.some((w) => /page 2/.test(w) && /no text/i.test(w))).toBe(true);
  });
});

describe("extractorAvailability", () => {
  it("names a backing for each of the three binary formats", async () => {
    const availability = await extractorAvailability();
    expect(availability.docx).toBe("builtin");
    expect(availability.xlsx).toBe("builtin");
    expect(["pdftotext", "pdfjs-dist"]).toContain(availability.pdf);
  });

  it("reports pdf as missing when neither pdftotext nor pdfjs-dist can be found", async () => {
    const availability = await extractorAvailability({
      exec: () => ({ code: 127, stdout: "", stderr: "not found" }),
      resolveModule: () => undefined,
    });
    expect(availability.pdf).toBe("missing");
  });
});
