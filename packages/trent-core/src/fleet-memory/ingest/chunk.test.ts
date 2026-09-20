/**
 * The chunker: heading-aware, page-aware, bounded, with stable ids. Pure text in, chunks out.
 *
 * What is pinned: a chunk never crosses a heading or a page; no chunk exceeds the bound; a
 * section longer than the bound is split with the configured overlap; ids are `<head>#<n>` and
 * do not move when the same text is chunked twice; a table split across chunks repeats its header.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_OVERLAP,
  chunkMarkdown,
  chunkUnits,
  locationTag,
  parseChunkId,
} from "./chunk.js";

const sentence = (i: number): string => `Sentence number ${String(i)} says something ordinary about the office and its routine. `;
const prose = (count: number): string => Array.from({ length: count }, (_, i) => sentence(i)).join("");

describe("chunkMarkdown", () => {
  it("splits at headings, keeps each section whole when it fits, and numbers ids from 1", () => {
    const markdown = ["# Handbook", "", "Intro paragraph.", "", "## Parking", "", "Park at the back.", "", "## Refunds", "", "Refunds take fourteen days."].join("\n");
    const chunks = chunkMarkdown("handbook", markdown);
    expect(chunks.map((c) => c.id)).toEqual(["handbook#1", "handbook#2", "handbook#3"]);
    expect(chunks[0]!.text).toContain("Intro paragraph.");
    expect(chunks[1]!.text.startsWith("## Parking")).toBe(true);
    expect(chunks[1]!.heading).toBe("Handbook > Parking");
    expect(chunks[2]!.text).toContain("Refunds take fourteen days.");
    expect(chunks[2]!.heading).toBe("Handbook > Refunds");
  });

  it("folds a heading with no body of its own into the section that follows it", () => {
    const chunks = chunkMarkdown("doc", "# Title\n\n## Only section\n\nBody text.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("# Title");
    expect(chunks[0]!.text).toContain("Body text.");
  });

  it("bounds every chunk and overlaps consecutive chunks of one long section", () => {
    const long = `## Long section\n\n${prose(60)}`;
    expect(long.length).toBeGreaterThan(DEFAULT_CHUNK_CHARS * 3);
    const chunks = chunkMarkdown("long", long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_CHARS);
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!.text;
      const current = chunks[i]!.text;
      // The overlap is the tail of the previous chunk from its first whole word onward.
      const tail = previous.slice(-DEFAULT_CHUNK_OVERLAP);
      const overlap = tail.slice(tail.search(/\s/)).trim();
      expect(overlap.length).toBeGreaterThan(20);
      expect(current.startsWith(overlap)).toBe(true);
      expect(chunks[i]!.heading).toBe("Long section");
    }
    const joined = chunks.map((c) => c.text).join(" ");
    expect(joined).toContain(sentence(59).trim());
  });

  it("honours a custom bound and overlap", () => {
    const chunks = chunkMarkdown("small", prose(20), { maxChars: 300, overlapChars: 40 });
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300);
    expect(chunks.length).toBeGreaterThan(4);
  });

  it("does not treat a heading inside a code fence as a section boundary", () => {
    const chunks = chunkMarkdown("code", "## Real\n\n```\n# not a heading\n```\n\nafter");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("# not a heading");
  });

  it("repeats a table's header row when the table is split across chunks", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| item-${String(i)} | ${String(i * 10)} dollars | a longer note about line ${String(i)} |`);
    const table = ["| item | amount | note |", "| --- | --- | --- |", ...rows].join("\n");
    const chunks = chunkMarkdown("sheet", table, { maxChars: 600, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.split("\n")[0]).toBe("| item | amount | note |");
      expect(chunk.text.split("\n")[1]).toBe("| --- | --- | --- |");
      expect(chunk.text.length).toBeLessThanOrEqual(600);
    }
    expect(chunks.at(-1)!.text).toContain("item-79");
  });

  it("is deterministic: the same text yields the same ids and bytes", () => {
    const text = `# A\n\n${prose(30)}\n\n## B\n\n${prose(30)}`;
    expect(chunkMarkdown("same", text)).toEqual(chunkMarkdown("same", text));
  });

  it("returns nothing for blank input", () => {
    expect(chunkMarkdown("empty", "   \n\n  ")).toEqual([]);
  });
});

describe("chunkUnits", () => {
  it("never crosses a page and tags each chunk with its page", () => {
    const chunks = chunkUnits("lease", [
      { text: "Parties and premises.", page: 1 },
      { text: `Rent clause.\n\n${prose(40)}`, page: 2 },
      { text: "Termination: ninety days notice.", page: 3 },
    ]);
    expect(chunks[0]).toMatchObject({ id: "lease#1", page: 1, text: "Parties and premises." });
    const pageTwo = chunks.filter((c) => c.page === 2);
    expect(pageTwo.length).toBeGreaterThan(1);
    for (const chunk of pageTwo) expect(chunk.text).not.toContain("Termination");
    const last = chunks.at(-1)!;
    expect(last).toMatchObject({ page: 3, id: `lease#${String(chunks.length)}` });
    expect(locationTag(last)).toBe("#p3");
  });

  it("tags a sheet unit by the sheet's slug", () => {
    const chunks = chunkUnits("numbers", [{ text: "| a | b |\n| --- | --- |\n| 1 | 2 |", sheet: "Q1 Costs" }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sheet).toBe("Q1 Costs");
    expect(locationTag(chunks[0]!)).toBe("#sheet:q1-costs");
    expect(locationTag({})).toBe("");
  });
});

describe("parseChunkId", () => {
  it("splits a chunk id into its head and ordinal", () => {
    expect(parseChunkId("lease#7")).toEqual({ head: "lease", n: 7 });
    expect(parseChunkId("decisions/2026-09-10-churn.md#1")).toEqual({ head: "decisions/2026-09-10-churn.md", n: 1 });
    expect(parseChunkId("lease")).toBeUndefined();
    expect(parseChunkId("lease#0")).toBeUndefined();
    expect(parseChunkId("#3")).toBeUndefined();
  });
});
