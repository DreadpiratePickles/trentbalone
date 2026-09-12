import { describe, expect, it } from "vitest";
import {
  buildDeliverable,
  renderCsv,
  renderHtmlDeck,
  renderHtmlReport,
  renderMarkdown,
  type DeliverableContent,
} from "./deliverable-builder";

const content: DeliverableContent = {
  title: "Weekly Founder Brief",
  subtitle: "Week of June 24",
  sections: [
    { heading: "Highlights", body: "Conversion up 18%.", bullets: ["Shipped pricing test", "Closed 2 deals"] },
    { heading: "Risks", body: "Runway tightening." },
  ],
  table: { columns: ["Metric", "Value"], rows: [["MRR", 4200], ["Signups", 130]] },
};

describe("deliverable-builder", () => {
  it("renders markdown with headings, bullets, and a table", () => {
    const md = renderMarkdown(content);
    expect(md).toContain("# Weekly Founder Brief");
    expect(md).toContain("## Highlights");
    expect(md).toContain("- Shipped pricing test");
    expect(md).toContain("| Metric | Value |");
    expect(md).toContain("| MRR | 4200 |");
  });

  it("renders a self-contained HTML report and escapes content", () => {
    const html = renderHtmlReport({ title: "A <b>x</b>", sections: [{ heading: "H&Q", body: "a < b" }] });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("A &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("H&amp;Q");
    expect(html).toContain("a &lt; b");
  });

  it("renders a deck with one slide per section plus a title slide", () => {
    const deck = renderHtmlDeck(content);
    // title slide + 2 sections + 1 data slide = 4 slides
    expect(deck.match(/class="slide/g)?.length).toBe(4);
    expect(deck).toContain("page-break-after:always");
  });

  it("renders CSV with proper escaping and CRLF", () => {
    const csv = renderCsv({ columns: ["a", "b,c"], rows: [["x", 'has "quote"'], ["plain", "line\nbreak"]] });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('a,"b,c"');
    expect(lines[1]).toBe('x,"has ""quote"""');
    expect(lines[2]).toBe('plain,"line\nbreak"');
  });

  it("buildDeliverable returns filename, mime, and content per format", () => {
    expect(buildDeliverable("markdown", content)).toMatchObject({ filename: "weekly-founder-brief.md", mimeType: "text/markdown" });
    expect(buildDeliverable("html", content).mimeType).toBe("text/html");
    expect(buildDeliverable("deck", content).filename).toBe("weekly-founder-brief.deck.html");
    expect(buildDeliverable("csv", content).mimeType).toBe("text/csv");
  });

  it("throws when a csv deliverable has no table", () => {
    expect(() => buildDeliverable("csv", { title: "x" })).toThrow(/table/);
  });
});
