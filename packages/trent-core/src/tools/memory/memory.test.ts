import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryAdapter, MEMORY_CAPS, MEMORY_TOOL_SCHEMAS, ENTRY_SEPARATOR } from "./index.js";

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

  it("a batch that removes 500 and adds 400 succeeds atomically against the final state", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "x".repeat(1700) });
    await call(a, { target: "memory", action: "add", content: "y".repeat(495) });
    expect(fs.readFileSync(memoryFile(), "utf8").length).toBe(1700 + ENTRY_SEPARATOR.length + 495);
    const rec = await call(a, {
      target: "memory",
      operations: [
        { action: "add", content: "z".repeat(400) },
        { action: "remove", old_text: "yyyy" },
      ],
    });
    expect(rec.status, rec.summary).toBe("completed");
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
        { action: "remove", old_text: "xxxx" },
        { action: "add", content: "w".repeat(2201) },
      ],
    });
    expect(rec.status).toBe("failed");
    expect(fs.readFileSync(memoryFile(), "utf8")).toBe(before);
  });

  it("replace swaps exactly one matching entry and refuses ambiguity or a miss", async () => {
    const a = createMemoryAdapter({ profileDir });
    await call(a, { target: "memory", action: "add", content: "Deploys on Fridays." });
    await call(a, { target: "memory", action: "add", content: "Deploys never on Mondays." });
    expect((await call(a, { target: "memory", action: "replace", old_text: "Deploys", content: "x" })).status).toBe("failed");
    expect((await call(a, { target: "memory", action: "replace", old_text: "Saturdays", content: "x" })).status).toBe("failed");
    const ok = await call(a, { target: "memory", action: "replace", old_text: "Fridays", content: "Deploys on Thursdays." });
    expect(ok.status).toBe("completed");
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
