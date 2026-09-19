/**
 * [C2] The brain repository: `<profileDir>/brain/` as the truth for identity, standing decisions
 * and episodic notes.
 *
 * What these tests hold down is the part a later change could quietly break: every write is
 * atomic and locked, a whole file is only ever rewritten through the delta operations
 * (`memory-ops.ts`), git is optional rather than required, and a path a model proposes can never
 * leave the brain directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BRAIN_SYSTEM_FILES,
  brainRelativePath,
  brainRoot,
  createBrain,
  nodeBrainExec,
  resolveBrainPath,
  type BrainExec,
} from "./brain.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/** A git that is not installed: every invocation reports the shell's "command not found" code. */
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

/** Records every argument vector so a test can prove no shell string was ever built. */
function recordingExec(): { exec: BrainExec; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec: BrainExec = (command, args, cwd) => {
    calls.push({ command, args });
    return nodeBrainExec(command, args, cwd);
  };
  return { exec, calls };
}

const gitAvailable = (): boolean => nodeBrainExec("git", ["--version"], profileDir).code === 0;

describe("the brain directory", () => {
  it("creates the layout on first use and is idempotent on the second", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    const first = brain.ensure();
    const root = brainRoot(profileDir);

    expect(first.created).toBe(true);
    expect(root).toBe(path.join(profileDir, "brain"));
    for (const file of BRAIN_SYSTEM_FILES) {
      expect(fs.existsSync(path.join(root, "system", file))).toBe(true);
    }
    for (const dir of ["system", "memory", "decisions", "seats"]) {
      expect(fs.statSync(path.join(root, dir)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(root, "skills-index.md"))).toBe(true);

    fs.writeFileSync(path.join(root, "system", "identity.md"), "the founder is Bobby", "utf8");
    const second = brain.ensure();
    expect(second.created).toBe(false);
    expect(fs.readFileSync(path.join(root, "system", "identity.md"), "utf8")).toBe("the founder is Bobby");
  });

  it("works as plain files when git is missing, and says versioning is off", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    const written = brain.appendNote({ text: "the invoice run finished", writer: "finance", runId: "run-1" });

    expect(brain.versioning()).toBe(false);
    expect(written.committed).toBe(false);
    expect(fs.readFileSync(written.path, "utf8")).toContain("the invoice run finished");
    expect(fs.existsSync(path.join(brainRoot(profileDir), ".git"))).toBe(false);
  });

  it("initialises git with an argument array and commits a writer and a run id", () => {
    if (!gitAvailable()) return;
    const { exec, calls } = recordingExec();
    const brain = createBrain({ profileDir, exec });
    brain.ensure();
    expect(brain.versioning()).toBe(true);

    const init = calls.find((c) => c.args[0] === "init");
    expect(init?.command).toBe("git");
    expect(Array.isArray(init?.args)).toBe(true);
    // Not one element of any invocation may be a shell string with an embedded space-separated
    // command: everything travels as its own argument.
    for (const call of calls) expect(call.args.some((a) => a.includes("&&") || a.includes("|"))).toBe(false);

    brain.appendNote({ text: "churn is concentrated in self-serve", writer: "analyst", runId: "run-7" });
    const log = brain.log(5);
    expect(log.length).toBeGreaterThan(0);
    const head = log[0];
    expect(head?.subject).toContain("memory/");
    expect(head?.body).toContain("analyst");
    expect(head?.body).toContain("run-7");
  });

  it("appends episodic notes to one file per day and never rewrites the earlier ones", () => {
    let day = "2026-09-18T09:00:00.000Z";
    const brain = createBrain({ profileDir, exec: noGit, now: () => new Date(day) });
    brain.ensure();
    brain.appendNote({ text: "first note", writer: "ceo" });
    brain.appendNote({ text: "second note", writer: "growth" });
    const first = fs.readFileSync(path.join(brainRoot(profileDir), "memory", "2026-09-18.md"), "utf8");
    expect(first.indexOf("first note")).toBeLessThan(first.indexOf("second note"));

    day = "2026-09-19T09:00:00.000Z";
    brain.appendNote({ text: "next day", writer: "ceo" });
    expect(fs.readFileSync(path.join(brainRoot(profileDir), "memory", "2026-09-19.md"), "utf8")).toContain("next day");
    expect(fs.readFileSync(path.join(brainRoot(profileDir), "memory", "2026-09-18.md"), "utf8")).toBe(first);
  });

  it("records a standing decision as its own dated file", () => {
    const brain = createBrain({ profileDir, exec: noGit, now: () => new Date("2026-09-18T09:00:00.000Z") });
    brain.ensure();
    const written = brain.recordDecision({
      title: "Sales is the ninth seat",
      body: "browser becomes a toolset every seat may use.",
      writer: "human",
    });
    expect(path.basename(written.path)).toBe("2026-09-18-sales-is-the-ninth-seat.md");
    const text = fs.readFileSync(written.path, "utf8");
    expect(text).toContain("2026-09-18");
    expect(text).toContain("Sales is the ninth seat");
    expect(text).toContain("browser becomes a toolset");
  });

  it("rewrites a system file only through the delta operations", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    brain.applyOps("system/facts.md", [{ op: "append", text: "pricing is per seat" }], { writer: "human" });
    brain.applyOps("system/facts.md", [{ op: "append", text: "the fiscal year starts in April" }], { writer: "human" });

    const refused = brain.applyOps("system/facts.md", [{ op: "remove", entry_id: "e9" }], { writer: "human" });
    expect(refused.ok).toBe(false);
    const kept = brain.readFile("system/facts.md") ?? "";
    expect(kept).toContain("pricing is per seat");
    expect(kept).toContain("the fiscal year starts in April");

    const applied = brain.applyOps("system/facts.md", [{ op: "replace", entry_id: "e1", text: "pricing is per active seat" }], { writer: "human" });
    expect(applied.ok).toBe(true);
    expect(brain.readFile("system/facts.md")).toContain("pricing is per active seat");
  });

  it("leaves no temporary or lock artefact behind", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    brain.appendNote({ text: "a note", writer: "ceo" });
    brain.writeSeatNote({ seat: "finance", text: "invoices are monthly", writer: "finance" });
    const leftovers = fs
      .readdirSync(path.join(brainRoot(profileDir), "memory"))
      .concat(fs.readdirSync(path.join(brainRoot(profileDir), "seats", "finance")))
      .filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    expect(leftovers).toEqual([]);
  });

  it("refuses a path that would leave the brain directory", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    for (const bad of ["../config.yaml", "/etc/passwd", "system/../../secrets.env", "seats/../../../x"]) {
      expect(() => resolveBrainPath(profileDir, bad)).toThrow();
      expect(brain.readFile(bad)).toBeUndefined();
    }
    expect(brainRelativePath(profileDir, path.join(brainRoot(profileDir), "system", "facts.md"))).toBe("system/facts.md");
  });

  it("lists the file tree as paths only, bounded", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    brain.appendNote({ text: "a very long body that must never reach the tree listing", writer: "ceo" });
    brain.writeSeatNote({ seat: "growth", text: "the growth seat's private note", writer: "growth" });
    const tree = brain.tree({ maxEntries: 3 });
    expect(tree.length).toBe(3);
    expect(tree.every((p) => !p.includes("very long body"))).toBe(true);
    expect([...tree]).toEqual([...tree].sort());
  });

  it("reports status without reading any note body", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    brain.appendNote({ text: "a note", writer: "ceo" });
    brain.recordDecision({ title: "One truth rule", body: "brain files win for identity.", writer: "human" });
    const status = brain.status();
    expect(status.root).toBe(brainRoot(profileDir));
    expect(status.versioning).toBe(false);
    expect(status.counts.memory).toBe(1);
    expect(status.counts.decisions).toBe(1);
    expect(status.counts.system).toBeGreaterThanOrEqual(BRAIN_SYSTEM_FILES.length);
  });
});
