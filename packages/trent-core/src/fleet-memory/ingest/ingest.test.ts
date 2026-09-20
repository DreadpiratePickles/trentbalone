/**
 * `trent brain import`, end to end: a founder drops files in, the brain holds them as Markdown
 * under `docs/` with provenance front matter, the index holds CHUNKS, recall cites a chunk id,
 * and `brain_read` expands that id. These are the audit's own definitions of done (harness
 * upgrade audit, section 4, items 1 and 2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryAdapter } from "../../tools/memory/index.js";
import { createBrainReadAdapter } from "../../tools/memory/brain-read.js";
import { createBrain, type Brain, type BrainExec } from "../brain.js";
import { loadBrainIndex, recallFromBrain } from "../brain-index.js";
import { DEFAULT_FLEET_MEMORY_CONFIG } from "../config.js";
import { createFleetMemoryHook } from "../orchestrator-hook.js";
import { InMemoryFleetSource } from "../source.js";
import { CONTEXT_BLOCKS, DEFAULT_CONTEXT_CEILING_CHARS } from "../tiers.js";
import { chunkBrainFile } from "./brain-chunks.js";
import { forgetBrainDoc, ingestDocuments, listBrainDocs } from "./index.js";
import { buildPdf, buildXlsx } from "./test-fixtures.js";

let profileDir: string;
let sourceDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });
const clock = (): Date => new Date("2026-09-20T10:00:00.000Z");

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-ingest-profile-")));
  sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-ingest-source-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

function brainWith(): Brain {
  const brain = createBrain({ profileDir, exec: noGit, now: clock });
  brain.ensure();
  return brain;
}

function write(name: string, contents: string | Buffer): string {
  const file = path.join(sourceDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

const TOPICS = [
  "parking", "dress code", "kitchen", "printers", "meeting rooms", "holidays", "expenses", "travel",
  "security badges", "wifi", "post room", "visitors", "first aid", "recycling", "bike storage", "desk booking",
];

/** Sixteen ordinary sections, then the one fact the seat will be asked about, under the LAST heading. */
const FACT = "We issue refunds within fourteen days of a cancellation request.";
function handbook(sectionChars = 700): string {
  const sections = TOPICS.map((topic, i) => {
    const sentences: string[] = [];
    let n = 0;
    while (sentences.join(" ").length < sectionChars) {
      sentences.push(`The ${topic} guidance item ${String(i)}-${String(n)} is reviewed by the office manager and posted on the noticeboard.`);
      n += 1;
    }
    return `## ${topic[0]!.toUpperCase()}${topic.slice(1)}\n\n${sentences.join(" ")}`;
  });
  return `# Staff handbook\n\n${sections.join("\n\n")}\n\n## Refund policy\n\n${FACT}\n`;
}

describe("trent brain import: Markdown", () => {
  it("imports a 12,000-character file, recalls the fact under its last heading by chunk id, and brain_read expands that id", async () => {
    const brain = brainWith();
    const text = handbook();
    expect(text.length).toBeGreaterThan(12_000);
    const file = write("handbook.md", text);

    const result = await ingestDocuments({ brain, paths: [file], now: clock });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ status: "imported", slug: "handbook", path: "docs/handbook.md", format: "md" });
    expect(result.files[0]!.chunks).toBeGreaterThan(10);

    const stored = brain.readFile("docs/handbook.md")!;
    expect(stored.startsWith("---\n")).toBe(true);
    expect(stored).toContain("provenance: founder-import");
    expect(stored).toContain(`source: ${file}`);
    expect(stored).toMatch(/sha256: [0-9a-f]{64}/);
    expect(stored).toContain("imported_at: 2026-09-20T10:00:00.000Z");

    const { chunks } = chunkBrainFile("docs/handbook.md", stored);
    const factChunk = chunks.find((c) => c.text.includes(FACT))!;
    expect(factChunk).toBeDefined();
    expect(factChunk.id).toBe(`handbook#${String(chunks.length)}`);
    expect(factChunk.heading).toBe("Staff handbook > Refund policy");

    const recall = await recallFromBrain({ profileDir, brain, seat: "support", objective: "how many days after a cancellation request do we issue refunds" });
    expect(recall.items.length).toBeGreaterThan(0);
    expect(recall.items[0]!.id).toBe(factChunk.id);
    const line = recall.block.split("\n").find((l) => l.startsWith(`- [${factChunk.id} `) || l.startsWith(`- [${factChunk.id}]`));
    expect(line).toBeDefined();
    expect(line).toContain("Staff handbook");
    expect(line).toContain(FACT);
    // One line per hit, a bounded snippet, never the document.
    expect(line!.length).toBeLessThan(DEFAULT_FLEET_MEMORY_CONFIG.recallSnippetChars + 120);
    expect(recall.block).not.toContain("The parking guidance item 0-3");
    expect(recall.block.length).toBeLessThanOrEqual(DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars);
    expect(recall.block).toContain("brain_read");

    const read = await createBrainReadAdapter({ profileDir }).execute(`brain_read {"id": "${factChunk.id}"}`, {});
    expect(read.status).toBe("completed");
    expect(read.summary).toContain(FACT);
    expect(read.summary).toContain(factChunk.id);
    expect(read.summary).toContain(`handbook#${String(chunks.length - 1)}`);
    expect(read.summary).not.toContain("The parking guidance item 0-0");
  });

  it("re-imports an unchanged file as a no-op and a changed file as a replacement of its doc and chunks", async () => {
    const brain = brainWith();
    const file = write("policy.md", "# Policy\n\nThe old clause says thirty days.\n");
    const first = await ingestDocuments({ brain, paths: [file], now: clock });
    expect(first.files[0]!.status).toBe("imported");
    const bytes = fs.readFileSync(path.join(brain.root, "docs", "policy.md"), "utf8");
    const before = loadBrainIndex({ profileDir, brain });
    expect(before.entries.some((e) => e.kind === "doc" && e.text.includes("thirty days"))).toBe(true);

    const again = await ingestDocuments({ brain, paths: [file], now: () => new Date("2026-09-21T10:00:00.000Z") });
    expect(again.files[0]!.status).toBe("unchanged");
    expect(fs.readFileSync(path.join(brain.root, "docs", "policy.md"), "utf8")).toBe(bytes);
    expect(loadBrainIndex({ profileDir, brain }).rebuilt).toBe(false);

    fs.writeFileSync(file, "# Policy\n\nThe new clause says sixty days.\n");
    const changed = await ingestDocuments({ brain, paths: [file], now: () => new Date("2026-09-22T10:00:00.000Z") });
    expect(changed.files[0]!.status).toBe("updated");
    expect(changed.files[0]!.path).toBe("docs/policy.md");
    const stored = brain.readFile("docs/policy.md")!;
    expect(stored).toContain("sixty days");
    expect(stored).not.toContain("thirty days");
    expect(stored).toContain("imported_at: 2026-09-22T10:00:00.000Z");
    const after = loadBrainIndex({ profileDir, brain });
    expect(after.rebuilt).toBe(true);
    expect(after.entries.some((e) => e.text.includes("thirty days"))).toBe(false);
    expect(after.entries.some((e) => e.kind === "doc" && e.text.includes("sixty days"))).toBe(true);
    expect(fs.readdirSync(path.join(brain.root, "docs"))).toEqual(["policy.md"]);
  });

  it("gives two files with the same name distinct slugs that stay stable across re-imports", async () => {
    const brain = brainWith();
    const a = write("a/report.md", "# Report A\n\nalpha");
    const b = write("b/report.md", "# Report B\n\nbeta");
    const first = await ingestDocuments({ brain, paths: [a, b], now: clock });
    expect(first.files.map((f) => f.slug)).toEqual(["report", "report-2"]);
    const second = await ingestDocuments({ brain, paths: [b, a], now: clock });
    expect(second.files.map((f) => [f.slug, f.status])).toEqual([["report-2", "unchanged"], ["report", "unchanged"]]);
  });
});

describe("trent brain import: PDF and XLSX", () => {
  it("imports a three-page PDF as three page-tagged chunks, and a query about page 3 returns #p3", async () => {
    const brain = brainWith();
    const file = write(
      "lease.pdf",
      buildPdf([
        ["Office lease agreement", "The parties and the premises are described on this page."],
        ["Rent", "The monthly rent is 2,400 dollars, payable on the first of the month."],
        ["Termination", "Either party may end this agreement with ninety days written notice."],
      ]),
    );
    const result = await ingestDocuments({ brain, paths: [file], now: clock });
    expect(result.files[0]).toMatchObject({ status: "imported", slug: "lease", format: "pdf", pages: 3, chunks: 3 });
    const stored = brain.readFile("docs/lease.md")!;
    expect(stored).toContain("pages: 3");
    const { chunks } = chunkBrainFile("docs/lease.md", stored);
    expect(chunks.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(chunks.map((c) => c.id)).toEqual(["lease#1", "lease#2", "lease#3"]);

    const recall = await recallFromBrain({ profileDir, brain, seat: "ops", objective: "how much written notice does termination of the lease require" });
    expect(recall.items[0]).toMatchObject({ id: "lease#3", page: 3 });
    const line = recall.block.split("\n").find((l) => l.startsWith("- [lease#3"));
    expect(line).toContain("#p3");
    expect(line).toContain("ninety days");
  });

  it("imports a two-sheet XLSX as two tables, one chunk per sheet, each tagged with its sheet", async () => {
    const brain = brainWith();
    const file = write(
      "numbers.xlsx",
      buildXlsx([
        { name: "Costs", rows: [["item", "amount"], ["rent", 2400], ["power", 310]] },
        { name: "Revenue", rows: [["month", "total"], ["January", 9100]] },
      ]),
    );
    const result = await ingestDocuments({ brain, paths: [file], now: clock });
    expect(result.files[0]).toMatchObject({ status: "imported", format: "xlsx", sheets: ["Costs", "Revenue"], chunks: 2 });
    const stored = brain.readFile("docs/numbers.md")!;
    expect(stored).toContain("| rent | 2400 |");
    expect(stored).toContain("| January | 9100 |");
    const { chunks } = chunkBrainFile("docs/numbers.md", stored);
    expect(chunks.map((c) => c.sheet)).toEqual(["Costs", "Revenue"]);
    expect(chunks[0]!.text).not.toContain("January");

    const recall = await recallFromBrain({ profileDir, brain, seat: "finance", objective: "what was the revenue total for January" });
    expect(recall.items[0]).toMatchObject({ id: "numbers#2", sheet: "Revenue" });
    expect(recall.block).toContain("#sheet:revenue");
  });
});

describe("trent brain import: directories, the ignore list and dry runs", () => {
  it("walks a directory, imports what it can and never reads a key or an env file", async () => {
    const brain = brainWith();
    write("notes/today.md", "# Today\n\nWe met the accountant.");
    write("notes/old.draft.md", "# Draft\n\nnot ready");
    write("notes/.env", "GEMINI_API_KEY=never-imported");
    write("notes/keys/private.pem", "-----BEGIN PRIVATE KEY-----\nnever-imported");
    write("notes/node_modules/dep/readme.md", "# Dep\n\nnever-imported");
    write("notes/photo.png", Buffer.from([0x89, 0x50]));
    write("notes/sub/plan.txt", "The plan is to open a second shop.");
    const result = await ingestDocuments({ brain, paths: [path.join(sourceDir, "notes")], ignore: ["*.draft.md"], now: clock });
    const imported = result.files.filter((f) => f.status === "imported").map((f) => f.slug).sort();
    expect(imported).toEqual(["plan", "today"]);
    const skipped = result.skipped.map((s) => path.basename(s.path)).sort();
    expect(skipped).toEqual([".env", "old.draft.md", "photo.png", "private.pem"]);
    expect(result.skipped.some((s) => s.path.includes("node_modules"))).toBe(false);
    const everything = brain.tree().map((rel) => brain.readFile(rel) ?? "").join("\n");
    expect(everything).not.toContain("never-imported");
  });

  it("refuses an explicitly named env file for the same reason", async () => {
    const brain = brainWith();
    const env = write("secret.env", "TOKEN=never-imported");
    const result = await ingestDocuments({ brain, paths: [env], now: clock });
    expect(result.files).toEqual([]);
    expect(result.skipped[0]!.path).toBe(env);
    expect(brain.tree().some((rel) => rel.startsWith("docs/"))).toBe(false);
  });

  it("fails one unreadable file without failing the batch", async () => {
    const brain = brainWith();
    const good = write("good.md", "# Good\n\nfine");
    const bad = write("bad.docx", Buffer.from("this is not a zip archive at all"));
    const result = await ingestDocuments({ brain, paths: [good, bad], now: clock });
    expect(result.files.map((f) => f.status)).toEqual(["imported", "failed"]);
    expect(result.files[1]!.reason).toBeTruthy();
    expect(result.files[1]!.reason).not.toContain("this is not a zip");
  });

  it("dry-runs the plan and writes nothing", async () => {
    const brain = brainWith();
    const file = write("plan.md", "# Plan\n\nopen a second shop");
    const result = await ingestDocuments({ brain, paths: [file], dryRun: true, now: clock });
    expect(result.dryRun).toBe(true);
    expect(result.files[0]).toMatchObject({ status: "imported", slug: "plan", format: "md" });
    expect(fs.existsSync(path.join(brain.root, "docs"))).toBe(false);
  });

  it("reports a path that does not exist as a usage error before touching anything", async () => {
    const brain = brainWith();
    await expect(ingestDocuments({ brain, paths: [path.join(sourceDir, "missing.md")], now: clock })).rejects.toThrow(/missing\.md/);
    expect(fs.existsSync(path.join(brain.root, "docs"))).toBe(false);
  });
});

describe("trent brain docs and forget", () => {
  it("lists imported documents with chunk counts, and forget removes a doc and its chunks", async () => {
    const brain = brainWith();
    const big = write("handbook.md", handbook());
    const small = write("memo.txt", "The memo says the shop opens at nine.");
    await ingestDocuments({ brain, paths: [big, small], now: clock });

    const docs = listBrainDocs(brain);
    expect(docs.map((d) => d.slug)).toEqual(["handbook", "memo"]);
    expect(docs[0]!.chunks).toBeGreaterThan(10);
    expect(docs[1]).toMatchObject({ chunks: 1, format: "txt", title: "memo", path: "docs/memo.md" });
    expect(docs[1]!.source).toBe(small);

    const before = loadBrainIndex({ profileDir, brain });
    expect(before.entries.some((e) => e.path === "docs/memo.md")).toBe(true);
    const removed = forgetBrainDoc(brain, "memo", { writer: "human" });
    expect(removed).toMatchObject({ path: "docs/memo.md", removed: true });
    expect(brain.readFile("docs/memo.md")).toBeUndefined();
    expect(listBrainDocs(brain).map((d) => d.slug)).toEqual(["handbook"]);
    const after = loadBrainIndex({ profileDir, brain });
    expect(after.entries.some((e) => e.path === "docs/memo.md")).toBe(false);

    expect(forgetBrainDoc(brain, "docs/handbook.md", { writer: "human" }).removed).toBe(true);
    expect(forgetBrainDoc(brain, "nothing-here", { writer: "human" }).removed).toBe(false);
    expect(() => forgetBrainDoc(brain, "../config.yaml", { writer: "human" })).toThrow(/brain/);
  });
});

describe("imported documents in a seat prompt", () => {
  it("keeps the CONTEXT tier under context.ceiling_chars and the recall block under its own budget", async () => {
    const brain = brainWith();
    write("big.md", handbook(2_500));
    const text = fs.readFileSync(path.join(sourceDir, "big.md"), "utf8");
    expect(text.length).toBeGreaterThan(40_000);
    await ingestDocuments({ brain, paths: [path.join(sourceDir, "big.md")], now: clock });

    const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, memory: createMemoryAdapter({ profileDir }), brain });
    let prelude = "";
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective?: string }; dynamicPrompt?: string }) => {
      prelude = input.dynamicPrompt ?? "";
      return {};
    });
    const objective = "how many days after a cancellation request do we issue refunds";
    hook.runStarted({ runId: "r1", companyId: "co_1", objective });
    await seat({ subtask: { id: "s1", seat: "support", objective } });

    const context = hook.contextFor("r1", "support")!;
    expect(context.ceilingChars).toBe(DEFAULT_CONTEXT_CEILING_CHARS);
    expect(context.contextChars).toBeLessThan(DEFAULT_CONTEXT_CEILING_CHARS);
    expect(context.dropped).toEqual([]);
    const recall = context.kept.find((b) => b.name === CONTEXT_BLOCKS.brainRecall)!;
    expect(recall).toBeDefined();
    expect(recall.tier).toBe("context");
    expect(recall.text.length).toBeLessThanOrEqual(DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars);
    expect(prelude).toContain(FACT);
    expect(prelude.length).toBeLessThan(text.length);
    // The stable tier does not move when a document is imported: docs are never listed there.
    const stable = hook.stablePreludeFor("r1")!;
    expect(stable).not.toContain("docs/big.md");
  });
});
