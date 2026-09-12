/**
 * Native deliverable rendering — turns structured agent output into real,
 * downloadable artifacts (Viktor-style "native outputs") with zero binary
 * dependencies:
 *   - markdown : a clean .md report
 *   - html     : a self-contained styled report (opens in any browser)
 *   - deck     : a self-contained HTML slide deck (one slide per section;
 *                Cmd/Ctrl-P → "Save as PDF" gives a real PDF/deck)
 *   - csv      : Excel/Sheets-compatible spreadsheet from a table
 *
 * These are intentionally dependency-free so they work inside any sandbox or
 * serverless runtime. Heavier native formats (xlsx/pptx) can layer on later.
 */

export type DeliverableFormat = "markdown" | "html" | "deck" | "csv";

export type DeliverableTable = {
  columns: string[];
  rows: Array<Array<string | number>>;
};

export type DeliverableSection = {
  heading: string;
  body?: string;
  bullets?: string[];
};

export type DeliverableContent = {
  title: string;
  subtitle?: string;
  sections?: DeliverableSection[];
  table?: DeliverableTable;
};

export type Deliverable = {
  format: DeliverableFormat;
  filename: string;
  mimeType: string;
  content: string;
};

export const DELIVERABLE_FORMATS: DeliverableFormat[] = ["markdown", "html", "deck", "csv"];

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)+/g, "").slice(0, 60) || "deliverable";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderMarkdown(content: DeliverableContent): string {
  const lines: string[] = [`# ${content.title}`];
  if (content.subtitle) lines.push("", `_${content.subtitle}_`);
  for (const section of content.sections ?? []) {
    lines.push("", `## ${section.heading}`);
    if (section.body) lines.push("", section.body);
    for (const bullet of section.bullets ?? []) lines.push(`- ${bullet}`);
  }
  if (content.table) {
    const { columns, rows } = content.table;
    lines.push("", `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) lines.push(`| ${row.map((c) => String(c)).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

function renderTableHtml(table: DeliverableTable): string {
  const head = `<tr>${table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
  const body = table.rows
    .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}

function sectionHtml(section: DeliverableSection): string {
  const parts: string[] = [`<h2>${escapeHtml(section.heading)}</h2>`];
  if (section.body) parts.push(`<p>${escapeHtml(section.body)}</p>`);
  if (section.bullets?.length) {
    parts.push(`<ul>${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`);
  }
  return parts.join("");
}

const BASE_CSS = `body{font-family:system-ui,-apple-system,sans-serif;color:#0e131d;line-height:1.55;margin:0}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:24px 0 6px}
.sub{color:#64748b;margin:0 0 16px}table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #d8dee9;padding:6px 10px;text-align:left;font-size:14px}th{background:#f1f5f9}`;

export function renderHtmlReport(content: DeliverableContent): string {
  const sections = (content.sections ?? []).map(sectionHtml).join("");
  const table = content.table ? renderTableHtml(content.table) : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(content.title)}</title>
<style>${BASE_CSS}.wrap{max-width:780px;margin:40px auto;padding:0 24px}</style></head>
<body><div class="wrap"><h1>${escapeHtml(content.title)}</h1>${
    content.subtitle ? `<p class="sub">${escapeHtml(content.subtitle)}</p>` : ""
  }${sections}${table}</div></body></html>`;
}

export function renderHtmlDeck(content: DeliverableContent): string {
  const slides: string[] = [
    `<section class="slide title"><h1>${escapeHtml(content.title)}</h1>${
      content.subtitle ? `<p class="sub">${escapeHtml(content.subtitle)}</p>` : ""
    }</section>`,
  ];
  for (const section of content.sections ?? []) {
    slides.push(`<section class="slide">${sectionHtml(section)}</section>`);
  }
  if (content.table) {
    slides.push(`<section class="slide"><h2>Data</h2>${renderTableHtml(content.table)}</section>`);
  }
  const deckCss = `${BASE_CSS}
.slide{box-sizing:border-box;min-height:100vh;padding:8vh 10vw;display:flex;flex-direction:column;justify-content:center;page-break-after:always;border-bottom:1px solid #e2e8f0}
.slide.title{background:#080a0f;color:#e7edf6}.slide.title .sub{color:#94a3b8}
@media print{.slide{min-height:100vh}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(content.title)}</title><style>${deckCss}</style></head>
<body>${slides.join("")}</body></html>`;
}

export function renderCsv(table: DeliverableTable): string {
  const lines = [table.columns.map(csvField).join(",")];
  for (const row of table.rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

const MIME: Record<DeliverableFormat, { mime: string; ext: string }> = {
  markdown: { mime: "text/markdown", ext: "md" },
  html: { mime: "text/html", ext: "html" },
  deck: { mime: "text/html", ext: "deck.html" },
  csv: { mime: "text/csv", ext: "csv" },
};

export function buildDeliverable(format: DeliverableFormat, content: DeliverableContent): Deliverable {
  if (format === "csv") {
    if (!content.table) throw new Error("csv deliverable requires content.table");
  }
  const rendered =
    format === "markdown" ? renderMarkdown(content)
    : format === "html" ? renderHtmlReport(content)
    : format === "deck" ? renderHtmlDeck(content)
    : renderCsv(content.table!);
  const { mime, ext } = MIME[format];
  return { format, filename: `${slugify(content.title)}.${ext}`, mimeType: mime, content: rendered };
}
