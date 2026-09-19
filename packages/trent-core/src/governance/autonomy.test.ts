/**
 * A2.2 — the autonomy level and the floor below it. The level decides how often a human is asked;
 * it never decides whether the hardline list, `approvals.deny` or the approval floor apply.
 */
import { describe, expect, it } from "vitest";
import { autonomyVerdict, AUTONOMY_LEVELS, AutonomyLevelSchema, DEFAULT_AUTONOMY, isPureRead, type AutonomyInput } from "./autonomy.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { TrentConfigSchema } from "../config/schema.js";

const clean: AutonomyInput = {
  level: "ask_dangerous",
  hardline: null,
  deny: null,
  floor: null,
  adapterAsks: false,
  pureRead: true,
};

describe("the config keys", () => {
  it("defaults to today's behaviour: ask only where the approval floors already ask", () => {
    expect(DEFAULT_AUTONOMY).toBe("ask_dangerous");
    expect(DEFAULT_CONFIG.autonomy).toBe("ask_dangerous");
    expect(TrentConfigSchema.parse({}).autonomy).toBe("ask_dangerous");
    expect(TrentConfigSchema.parse({}).approvals.deny).toEqual([]);
  });

  it("refuses a level nobody implements", () => {
    expect(AutonomyLevelSchema.safeParse("yolo").success).toBe(false);
    expect([...AUTONOMY_LEVELS]).toEqual(["ask_always", "ask_dangerous", "never"]);
  });
});

describe("the floor sits below every level", () => {
  it("refuses a hardline hit at every level, naming the rule", () => {
    for (const level of AUTONOMY_LEVELS) {
      const verdict = autonomyVerdict({ ...clean, level, hardline: { id: "fork-bomb", reason: "a fork bomb takes the machine down" } });
      expect(verdict.outcome).toBe("refuse");
      expect(verdict.reason).toContain("fork-bomb");
    }
  });

  it("refuses a deny-glob hit at every level, naming the glob", () => {
    for (const level of AUTONOMY_LEVELS) {
      const verdict = autonomyVerdict({ ...clean, level, deny: { glob: "*terraform*", subject: "terraform destroy" } });
      expect(verdict.outcome).toBe("refuse");
      expect(verdict.reason).toContain("*terraform*");
    }
  });

  it("refuses anything the approval floor marks never-auto-approvable, at every level", () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(autonomyVerdict({ ...clean, level, floor: "recursive delete of root filesystem" }).outcome).toBe("refuse");
    }
  });

  it("puts the hardline list ahead of the deny globs, so the shipped reason wins", () => {
    const verdict = autonomyVerdict({
      ...clean,
      level: "never",
      hardline: { id: "fork-bomb", reason: "a fork bomb takes the machine down" },
      deny: { glob: "*", subject: "x" },
    });
    expect(verdict.reason).toContain("fork-bomb");
  });
});

describe("ask_dangerous — today's behaviour", () => {
  it("auto-approves a read tool", () => {
    expect(autonomyVerdict({ ...clean, level: "ask_dangerous", pureRead: true, adapterAsks: false }).outcome).toBe("allow");
  });

  it("asks wherever the approval floors already ask", () => {
    expect(autonomyVerdict({ ...clean, level: "ask_dangerous", pureRead: false, adapterAsks: true }).outcome).toBe("ask");
  });

  it("does not ask for a non-read the floors are happy with", () => {
    expect(autonomyVerdict({ ...clean, level: "ask_dangerous", pureRead: false, adapterAsks: false }).outcome).toBe("allow");
  });
});

describe("ask_always", () => {
  it("asks for every call that is not a pure read", () => {
    expect(autonomyVerdict({ ...clean, level: "ask_always", pureRead: false, adapterAsks: false }).outcome).toBe("ask");
  });

  it("still lets a pure read through, so the level is usable", () => {
    expect(autonomyVerdict({ ...clean, level: "ask_always", pureRead: true, adapterAsks: false }).outcome).toBe("allow");
  });
});

describe("never", () => {
  it("auto-approves everything the floors would have asked about", () => {
    expect(autonomyVerdict({ ...clean, level: "never", pureRead: false, adapterAsks: true }).outcome).toBe("allow");
  });
});

describe("isPureRead", () => {
  it("calls a file read a pure read", () => {
    expect(isPureRead({ adapter: "file_ops", scopes: ["file_ops"], tool: "read_file", args: { path: "README.md" } })).toBe(true);
  });

  it("does not call a write, a terminal command or a web fetch a pure read", () => {
    expect(isPureRead({ adapter: "file_ops", scopes: ["file_ops"], tool: "write_file", args: { path: "a.txt", content: "x" } })).toBe(false);
    expect(isPureRead({ adapter: "terminal", scopes: ["terminal"], tool: "terminal", args: { command: "ls" } })).toBe(false);
    expect(isPureRead({ adapter: "web", scopes: ["web"], tool: "web_search", args: { query: "trent" } })).toBe(false);
  });
});
