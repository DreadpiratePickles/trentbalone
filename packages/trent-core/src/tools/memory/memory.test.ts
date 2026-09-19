import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryAdapter, DEFAULT_MEMORY_BLOCKS, MEMORY_CAPS, MEMORY_TOOL_SCHEMAS, ENTRY_SEPARATOR } from "./index.js";
import { TrentConfigSchema } from "../../config/schema.js";

let profileDir: string;
const memoryFile = () => path.join(profileDir, "memories", "MEMORY.md");
const userFile = () => path.join(profileDir, "memories", "USER.md");

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mem-"));
});

function call(adapter: ReturnType<typeof createMemoryAdapter>, args: Record<string, unknown>) {
  return adapter.execute(`memory ${JSON.stringify(args)}`, {});
}

describe("memory toolset", () => {
  it("adds an entry, writes 0600, and reports the remaining budget", async () => {
    const a = createMemoryAdapter({ profileDir });
    const rec = await call(a, { target: "memory", action: "add", content: "Prefers TypeScript strict mode." });
    expect(rec.status).toBe("completed");
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe("Prefers TypeScript strict mode.");
    expect(fs.statSync(memoryFile()).mode & 0o777).toBe(0o600);
    expect(rec.summary).toMatch(new RegExp(`${MEMORY_CAPS.memory - "Prefers TypeScript strict mode.".length} `));
  });

  it("refuses an add past 2200 chars, names the remaining budget, and leaves the file byte-identical", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "a".repeat(2000) });
    const before = fs.readFileSync(memoryFile());
    const rec = await call(a, { target: "memory", action: "add", content: "b".repeat(300) });
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/2200/);
    expect(rec.summary).toMatch(/200 char/);
    expect(fs.readFileSync(memoryFile()).equals(before)).toBe(true);
    expect(fs.readdirSync(path.dirname(memoryFile())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("USER.md has the 1375 cap", async () => {
    const a = createMemoryAdapter({ profileDir });
    const rec = await call(a, { target: "user", action: "add", content: "u".repeat(1376) });
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/1375/);
    expect(fs.existsSync(userFile())).toBe(false);
    expect((await call(a, { target: "user", action: "add", content: "u".repeat(1375) })).status).toBe("completed");
  });

  it("a batch that removes 500 and adds 400 succeeds atomically against the final state, for the block's one rewriter", async () => {
    const { commitOperations, CONSOLIDATION_WRITE_GATE } = await import("./store.js");
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "x".repeat(1700) });
    await call(a, { target: "memory", action: "add", content: "y".repeat(495) });
    expect(fs.readFileSync(memoryFile(), "utf8").length).toBe(1700 + ENTRY_SEPARATOR.length + 495);
    const result = commitOperations(
      profileDir,
      "memory",
      [
        { action: "add", content: "z".repeat(400) },
        { action: "remove", old_text: "yyyy" },
      ],
      MEMORY_CAPS.memory,
      CONSOLIDATION_WRITE_GATE,
    );
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    const text = fs.readFileSync(memoryFile(), "utf8");
    expect(text).not.toContain("y");
    expect(text).toContain("z".repeat(400));
    expect(text.split(ENTRY_SEPARATOR)).toHaveLength(2);
  });

  it("a batch that would end over cap fails as a whole and changes nothing", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "x".repeat(2100) });
    const before = fs.readFileSync(memoryFile(), "utf8");
    const rec = await call(a, {
      target: "memory",
      operations: [
        { action: "add", content: "w".repeat(50) },
        { action: "add", content: "w".repeat(2201) },
      ],
    });
    expect(rec.status).toBe("failed");
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe(before);
  });

  it("replace swaps exactly one matching entry and refuses ambiguity or a miss, on the consolidation path", async () => {
    const { commitOperations, CONSOLIDATION_WRITE_GATE } = await import("./store.js");
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "Deploys on Fridays." });
    await call(a, { target: "memory", action: "add", content: "Deploys never on Mondays." });
    const swap = (old_text: string, content: string) =>
      commitOperations(profileDir, "memory", [{ action: "replace", old_text, content }], MEMORY_CAPS.memory, CONSOLIDATION_WRITE_GATE);
    expect(swap("Deploys", "x").ok).toBe(false);
    expect(swap("Saturdays", "x").ok).toBe(false);
    expect(swap("Fridays", "Deploys on Thursdays.").ok).toBe(true);
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe(`Deploys on Thursdays.${ENTRY_SEPARATOR}Deploys never on Mondays.`);
  });

  it("frozenSnapshot renders both files once and does not change mid-session", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "first" });
    await call(a, { target: "user", action: "add", content: "Bobby" });
    const snap = a.frozenSnapshot();
    expect(snap).toContain("first");
    expect(snap).toContain("Bobby");
    await call(a, { target: "memory", action: "add", content: "second" });
    fs.writeFileSync(userFile(), "someone else");
    expect(a.frozenSnapshot()).toBe(snap);
    expect(a.frozenSnapshot()).not.toContain("second");
  });

  it("a delegated (read-only) seat cannot write", async () => {
    const a = createMemoryAdapter({ profileDir, readOnly: true });
    const rec = await call(a, { target: "memory", action: "add", content: "nope" });
    expect(rec.status).toBe("blocked");
    expect(fs.existsSync(memoryFile())).toBe(false);
    expect(a.requiresApproval("memory {}")).toBe(false);
  });

  it("validates target and action, and exposes the schema as data", async () => {
    const a = createMemoryAdapter({ profileDir });
    expect((await call(a, { target: "vault", action: "add", content: "x" })).status).toBe("failed");
    expect((await call(a, { target: "memory", action: "explode", content: "x" })).status).toBe("failed");
    expect((await call(a, { target: "memory", action: "add" })).status).toBe("failed");
    expect(MEMORY_TOOL_SCHEMAS[0]!.name).toBe("memory");
    expect(MEMORY_TOOL_SCHEMAS[0]!.parameters.required).toEqual(["target"]);
    expect(await a.healthCheck()).toBe("connected");
  });
});

describe("shared company memory (fleet)", () => {
  it("a seat marked delegated by the caller context cannot write, even on a writable adapter", async () => {
    let delegated = false;
    const a = createMemoryAdapter({ profileDir, callerContext: () => ({ delegated }) });
    expect((await call(a, { target: "memory", action: "add", content: "parent wrote this" })).status).toBe("completed");
    delegated = true;
    const rec = await call(a, { target: "memory", action: "add", content: "child tried this" });
    expect(rec.status).toBe("blocked");
    expect(rec.summary).toMatch(/delegated/);
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe("parent wrote this");
    // Reading is still allowed: the snapshot renders for a delegated child.
    expect(a.frozenSnapshot()).toContain("parent wrote this");
  });

  it("two seats writing different entries against a stale view both survive: merge is by entry, not by file", async () => {
    const { commitOperations, readEntries, MEMORY_CAPS } = await import("./store.js");
    // Seat A and seat B each read the file (empty), then each commits its own add. Neither
    // clobbers the other because the commit re-reads under the lock before applying.
    const a = commitOperations(profileDir, "memory", [{ action: "add", content: "A: churn cohorts defined by signup month" }], MEMORY_CAPS.memory);
    const b = commitOperations(profileDir, "memory", [{ action: "add", content: "B: deploys are Thursday only" }], MEMORY_CAPS.memory);
    expect(a.ok && b.ok).toBe(true);
    const entries = readEntries(profileDir, "memory");
    expect(entries).toHaveLength(2);
    expect(entries.join("\n")).toContain("A: churn");
    expect(entries.join("\n")).toContain("B: deploys");
    expect(fs.readFileSync(memoryFile(), "utf8").length).toBeLessThanOrEqual(MEMORY_CAPS.memory);
    expect(fs.readdirSync(path.dirname(memoryFile())).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);
  });

  it("two OS processes appending concurrently both land and the file stays under cap", async () => {
    const { execFile } = await import("node:child_process");
    const storeUrl = new URL("./store.ts", import.meta.url).href;
    const script = (label: string) =>
      `import { commitOperations, MEMORY_CAPS } from ${JSON.stringify(storeUrl)};\n` +
      `for (let i = 0; i < 20; i += 1) {\n` +
      `  const r = commitOperations(${JSON.stringify(profileDir)}, "memory", [{ action: "add", content: "${label}-" + i }], MEMORY_CAPS.memory);\n` +
      `  if (!r.ok) { console.error(r.reason); process.exit(2); }\n` +
      `}\n`;
    const run = (label: string) =>
      new Promise<number>((resolve) =>
        execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script(label)], { cwd: process.cwd() }, (err, _out, stderr) =>
          resolve(err ? ((err as { code?: number }).code ?? 1) : (stderr.trim() ? 3 : 0))));
    const [ca, cb] = await Promise.all([run("alpha"), run("beta")]);
    expect([ca, cb]).toEqual([0, 0]);
    const text = fs.readFileSync(memoryFile(), "utf8");
    const entries = text.split(ENTRY_SEPARATOR);
    expect(entries).toHaveLength(40);
    for (let i = 0; i < 20; i += 1) {
      expect(entries).toContain(`alpha-${i}`);
      expect(entries).toContain(`beta-${i}`);
    }
    expect(text.length).toBeLessThanOrEqual(MEMORY_CAPS.memory);
  }, 60_000);

  it("thaw() lets the next run see what the previous run wrote, while the current run's view stays frozen", async () => {
    const a = createMemoryAdapter({ profileDir });
    const run1 = a.frozenSnapshot();
    await call(a, { target: "memory", action: "add", content: "engineer: the API rate limit is 60/min" });
    expect(a.frozenSnapshot()).toBe(run1);
    a.thaw();
    expect(a.frozenSnapshot()).toContain("rate limit is 60/min");
  });
});

describe("named memory blocks (T4.3)", () => {
  const companyFile = () => path.join(profileDir, "memories", "COMPANY.md");

  it("a seat write to the read_only company block is refused naming the label, and the file is untouched", async () => {
    const a = createMemoryAdapter({ profileDir });
    const rec = await call(a, { block: "company", action: "add", content: "We sell to mid-market fintech." });
    expect(rec.status).toBe("blocked");
    expect(rec.summary).toMatch(/company/);
    expect(rec.summary).toMatch(/read.only/i);
    expect(fs.existsSync(companyFile())).toBe(false);
  });

  it("the prelude lists every default block with its label, description, limit and current bytes", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { block: "memory", action: "add", content: "first fact" });
    fs.writeFileSync(companyFile(), "Founded 2024.");
    const snap = a.frozenSnapshot();
    for (const block of DEFAULT_MEMORY_BLOCKS) {
      expect(snap).toContain(block.label);
      expect(snap).toContain(block.file);
      expect(snap).toContain(block.description);
      expect(snap).toContain(`${block.limit}`);
    }
    expect(snap).toMatch(/company[^\n]*read-only/);
    expect(snap).toMatch(/COMPANY\.md[^\n]*13 chars used/);
    expect(snap).toMatch(/MEMORY\.md[^\n]*10 chars used/);
    expect(snap).toContain("Founded 2024.");
  });

  it("a configured fourth block shows up in the prelude and enforces its own limit", async () => {
    const product = { label: "product", file: "PRODUCT.md", description: "what we are building and why", limit: 800, read_only: false };
    const a = createMemoryAdapter({ profileDir, blocks: [...DEFAULT_MEMORY_BLOCKS, product] });
    expect(a.frozenSnapshot()).toMatch(/PRODUCT\.md[^\n]*product[^\n]*800/);
    expect(a.instructions).toContain("product");
    const ok = await call(a, { block: "product", action: "add", content: "p".repeat(800) });
    expect(ok.status, ok.summary).toBe("completed");
    expect(fs.readFileSync(path.join(profileDir, "memories", "PRODUCT.md"), "utf8")).toBe("p".repeat(800));
    const over = await call(a, { block: "product", action: "add", content: "p" });
    expect(over.status).toBe("failed");
    expect(over.summary).toMatch(/800/);
    expect(fs.readFileSync(path.join(profileDir, "memories", "PRODUCT.md"), "utf8")).toBe("p".repeat(800));
  });

  it("block defaults to memory, an unknown block is refused naming the known labels, and target stays an alias", async () => {
    const a = createMemoryAdapter({ profileDir });
    expect((await call(a, { action: "add", content: "defaulted" })).status).toBe("completed");
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe("defaulted");
    const rec = await call(a, { block: "vault", action: "add", content: "x" });
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/vault/);
    expect(rec.summary).toMatch(/memory, user, company/);
    expect((await call(a, { target: "user", action: "add", content: "alias" })).status).toBe("completed");
  });

  it("a configured limit on a DEFAULT block is what the writer enforces, not the shipped cap", async () => {
    const { commitOperations } = await import("./store.js");
    const blocks = DEFAULT_MEMORY_BLOCKS.map((b) => (b.label === "memory" ? { ...b, limit: 3000 } : b));

    const ok = commitOperations(profileDir, "memory", [{ action: "add", content: "z".repeat(2900) }], { blocks });
    expect(ok.ok, ok.ok ? "" : ok.reason).toBe(true);
    // 2900 is well past the shipped 2200 cap; the remaining budget proves which number was used.
    expect(ok.ok && ok.remaining).toBe(100);

    const over = commitOperations(profileDir, "memory", [{ action: "add", content: "z".repeat(200) }], { blocks });
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toContain("3000");
  });

  it("with no configured block list the writer falls back to the shipped cap", async () => {
    const { commitOperations, MEMORY_CAPS, memoryLimit } = await import("./store.js");
    expect(memoryLimit("memory")).toBe(MEMORY_CAPS.memory);
    expect(memoryLimit("user")).toBe(MEMORY_CAPS.user);

    const ok = commitOperations(profileDir, "memory", [{ action: "add", content: "z".repeat(2100) }]);
    expect(ok.ok && ok.remaining).toBe(MEMORY_CAPS.memory - 2100);
    const over = commitOperations(profileDir, "memory", [{ action: "add", content: "z".repeat(200) }]);
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toContain(String(MEMORY_CAPS.memory));
  });

  it("an over-limit refusal carries the current entries and the usage, so the seat can consolidate in the same turn", async () => {
    const { commitOperations, MEMORY_CAPS } = await import("./store.js");
    commitOperations(profileDir, "memory", [{ action: "add", content: "deploys are Thursday only" }]);
    commitOperations(profileDir, "memory", [{ action: "add", content: "x".repeat(2160) }]);

    const refused = commitOperations(profileDir, "memory", [{ action: "add", content: "one more fact" }]);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected the write to be refused");
    expect(refused.entries).toEqual(["deploys are Thursday only", "x".repeat(2160)]);
    expect(refused.used).toBe(25 + ENTRY_SEPARATOR.length + 2160);
    expect(refused.limit).toBe(MEMORY_CAPS.memory);

    // The tool result carries the same material, so the model sees what to drop without re-reading.
    const a = createMemoryAdapter({ profileDir });
    const rec = await call(a, { block: "memory", action: "add", content: "one more fact" });
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("deploys are Thursday only");
    expect(rec.summary).toContain(String(MEMORY_CAPS.memory));
  });

  it("the adapter enforces a configured override of the default block's limit", async () => {
    const blocks = DEFAULT_MEMORY_BLOCKS.map((b) => (b.label === "memory" ? { ...b, limit: 3000 } : b));
    const a = createMemoryAdapter({ profileDir, blocks });
    const ok = await call(a, { block: "memory", action: "add", content: "z".repeat(2900) });
    expect(ok.status, ok.summary).toBe("completed");
    expect(ok.summary).toContain("3000");
    const over = await call(a, { block: "memory", action: "add", content: "z".repeat(200) });
    expect(over.status).toBe("failed");
    expect(over.summary).toContain("3000");
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe("z".repeat(2900));
  });

  it("the config schema defaults memory.blocks to the three blocks and validates a custom one", () => {
    const parsed = TrentConfigSchema.parse({});
    expect(parsed.memory.blocks.map((b) => b.label)).toEqual(["memory", "user", "company"]);
    expect(parsed.memory.blocks.find((b) => b.label === "company")?.read_only).toBe(true);
    const custom = TrentConfigSchema.parse({ memory: { blocks: [{ label: "product", file: "PRODUCT.md", description: "the product", limit: 800 }] } });
    expect(custom.memory.blocks).toEqual([{ label: "product", file: "PRODUCT.md", description: "the product", limit: 800, read_only: false }]);
    expect(() => TrentConfigSchema.parse({ memory: { blocks: [{ label: "Bad Label", file: "X.md", description: "x", limit: 1 }] } })).toThrow();
    expect(() => TrentConfigSchema.parse({ memory: { blocks: [{ label: "x1", file: "X.md", description: "x", limit: 0 }] } })).toThrow();
  });
});

describe("[C4] write gates by layer", () => {
  const companyFile = () => path.join(profileDir, "memories", "COMPANY.md");

  it("a seat's append is ungated: the episodic layer takes writes from any seat", async () => {
    const a = createMemoryAdapter({ profileDir });
    expect((await call(a, { block: "memory", action: "add", content: "the API rate limit is 60/min" })).status).toBe("completed");
    expect((await call(a, { block: "memory", operations: [{ action: "add", content: "invoices go out on the 1st" }] })).status).toBe("completed");
    expect(fs.readFileSync(memoryFile(), "utf8").split(ENTRY_SEPARATOR)).toHaveLength(2);
  });

  it("a seat's replace or remove is refused: a rewrite has one owner, the consolidation draft", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { block: "memory", action: "add", content: "the API rate limit is 60/min" });
    const before = fs.readFileSync(memoryFile(), "utf8");
    for (const args of [
      { block: "memory", action: "replace", old_text: "rate limit", content: "the API rate limit is 100/min" },
      { block: "memory", action: "remove", old_text: "rate limit" },
      { block: "memory", operations: [{ action: "add", content: "fresh" }, { action: "remove", old_text: "rate limit" }] },
    ]) {
      const rec = await call(a, args);
      expect(rec.status, JSON.stringify(args)).toBe("blocked");
      expect(rec.summary).toMatch(/consolidat/i);
    }
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe(before);
    // The advertised schema no longer offers a seat an action it cannot take.
    const action = MEMORY_TOOL_SCHEMAS[0]!.parameters.properties.action as { enum: string[] };
    expect(action.enum).toEqual(["add"]);
  });

  it("the store refuses a seat rewrite even when the adapter is bypassed, and says what the block is now", async () => {
    const { commitOperations } = await import("./store.js");
    commitOperations(profileDir, "memory", [{ action: "add", content: "deploys are Thursday only" }]);
    const refused = commitOperations(profileDir, "memory", [{ action: "remove", old_text: "Thursday" }]);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected the rewrite to be refused");
    expect(refused.entries).toEqual(["deploys are Thursday only"]);
    expect(refused.limit).toBe(MEMORY_CAPS.memory);
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe("deploys are Thursday only");
  });

  it("a read_only block is refused on every path, including the consolidation writer, until it is listed", async () => {
    const { commitOperations, CONSOLIDATION_WRITE_GATE, checkMemoryWriteGate } = await import("./store.js");
    const company = DEFAULT_MEMORY_BLOCKS.find((b) => b.label === "company")!;
    const add = [{ action: "add" as const, content: "We sell to mid-market fintech." }];

    expect(checkMemoryWriteGate(company, add, { writer: "seat", blocks: DEFAULT_MEMORY_BLOCKS })).not.toBeNull();
    const unlisted = commitOperations(profileDir, company, add, { blocks: DEFAULT_MEMORY_BLOCKS }, CONSOLIDATION_WRITE_GATE);
    expect(unlisted.ok).toBe(false);
    if (unlisted.ok) throw new Error("expected the read-only block to be refused");
    expect(unlisted.reason).toMatch(/consolidation_may_edit/);
    expect(fs.existsSync(companyFile())).toBe(false);

    const listed = commitOperations(profileDir, company, add, { blocks: DEFAULT_MEMORY_BLOCKS }, { writer: "consolidation", consolidationMayEdit: ["company"] });
    expect(listed.ok, listed.ok ? "" : listed.reason).toBe(true);
    expect(fs.readFileSync(companyFile(), "utf8")).toBe("We sell to mid-market fintech.");
  });

  it("a listed read_only block is still refused to a seat: the listing names the scheduled consolidation only", async () => {
    const { commitOperations } = await import("./store.js");
    const company = DEFAULT_MEMORY_BLOCKS.find((b) => b.label === "company")!;
    const refused = commitOperations(profileDir, company, [{ action: "add", content: "x" }], { blocks: DEFAULT_MEMORY_BLOCKS }, {
      writer: "seat",
      consolidationMayEdit: ["company"],
    });
    expect(refused.ok).toBe(false);
    expect(fs.existsSync(companyFile())).toBe(false);
  });

  it("the config schema carries memory.consolidation_may_edit, empty by default, and validates the labels", () => {
    const parsed = TrentConfigSchema.parse({});
    expect(parsed.memory.consolidation_may_edit).toEqual([]);
    const listed = TrentConfigSchema.parse({ memory: { consolidation_may_edit: ["company"] } });
    expect(listed.memory.consolidation_may_edit).toEqual(["company"]);
    expect(listed.memory.blocks.map((b) => b.label)).toEqual(["memory", "user", "company"]);
    expect(() => TrentConfigSchema.parse({ memory: { consolidation_may_edit: ["Not A Label"] } })).toThrow();
  });
});
