/**
 * D4 RED — verify_on_stop: a turn that edited code cannot give a final answer on its own word.
 *
 * Four cases, and the third is the whole point: a green test run from BEFORE the last write proves
 * nothing about the bytes on disk now, so it does not count.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFY_COMMANDS,
  VerificationLedger,
  commandArgv,
  matchesVerification,
  turnWrites,
  verifyOnStop,
} from "./index.js";

const COMMANDS = DEFAULT_VERIFY_COMMANDS;

function rows(turn: number, at: string, path = "src/parser.ts"): { turn: number; path: string; at: string; tool: string }[] {
  return [{ turn, path, at, tool: "write_file" }];
}

describe("what counts as a verification command", () => {
  it("matches on the executable and the first argument, ignoring the path it was invoked by", () => {
    expect(matchesVerification(["/usr/local/bin/npm", "test", "--", "-t", "parser"], COMMANDS)).toBe(true);
    expect(matchesVerification(["npx", "tsc", "--noEmit"], COMMANDS)).toBe(true);
    expect(matchesVerification(["pytest", "-q"], COMMANDS)).toBe(true);
    expect(matchesVerification(["npm", "run", "build"], COMMANDS)).toBe(false);
    expect(matchesVerification(["echo", "tests pass"], COMMANDS)).toBe(false);
  });

  it("reads an argv out of a shell command line without ever running it", () => {
    expect(commandArgv("npx tsc --noEmit -p apps/cli/tsconfig.json")).toEqual(["npx", "tsc", "--noEmit", "-p", "apps/cli/tsconfig.json"]);
    expect(commandArgv("  ")).toEqual([]);
  });
});

describe("verify_on_stop", () => {
  it("passes a turn whose write was followed by a green npx tsc", () => {
    const ledger = new VerificationLedger();
    ledger.record({ command: ["npx", "tsc", "--noEmit"], exitCode: 0, at: 2_000 });
    const writes = turnWrites(rows(1, new Date(1_000).toISOString()), 1);
    expect(verifyOnStop({ enabled: true, writes, evidence: ledger.all(), commands: COMMANDS })).toBeUndefined();
  });

  it("refuses a turn that wrote a file and verified nothing, naming the file and what to run", () => {
    const writes = turnWrites(rows(1, new Date(1_000).toISOString()), 1);
    const refusal = verifyOnStop({ enabled: true, writes, evidence: [], commands: COMMANDS });
    expect(refusal?.files).toEqual(["src/parser.ts"]);
    expect(refusal?.reason).toContain("src/parser.ts");
    expect(refusal?.reason).toContain("npx tsc");
  });

  it("does not count a verification that ran before the last write", () => {
    const ledger = new VerificationLedger();
    ledger.record({ command: ["npm", "test"], exitCode: 0, at: 500 });
    const writes = turnWrites(rows(1, new Date(1_000).toISOString()), 1);
    expect(verifyOnStop({ enabled: true, writes, evidence: ledger.all(), commands: COMMANDS })?.files).toEqual(["src/parser.ts"]);
  });

  it("does not count a verification that ran after the write and failed", () => {
    const ledger = new VerificationLedger();
    ledger.record({ command: ["npm", "test"], exitCode: 1, at: 2_000 });
    const writes = turnWrites(rows(1, new Date(1_000).toISOString()), 1);
    expect(verifyOnStop({ enabled: true, writes, evidence: ledger.all(), commands: COMMANDS })).toBeDefined();
  });

  it("leaves a turn that wrote nothing alone, and is inert when the key is off", () => {
    expect(verifyOnStop({ enabled: true, writes: [], evidence: [], commands: COMMANDS })).toBeUndefined();
    const writes = turnWrites(rows(1, new Date(1_000).toISOString()), 1);
    expect(verifyOnStop({ enabled: false, writes, evidence: [], commands: COMMANDS })).toBeUndefined();
  });

  it("reads only the rows of the turn that is ending, and never a rollback's own rows", () => {
    const mixed = [
      ...rows(1, new Date(1_000).toISOString(), "src/a.ts"),
      ...rows(2, new Date(2_000).toISOString(), "src/b.ts"),
      { turn: 2, path: "src/c.ts", at: new Date(3_000).toISOString(), tool: "rollback" },
    ];
    expect(turnWrites(mixed, 2).map((write) => write.path)).toEqual(["src/b.ts"]);
  });
});

describe("the evidence ledger", () => {
  it("records a terminal call's argv and the exit code the record reports", () => {
    const ledger = new VerificationLedger();
    ledger.observe("terminal", 'terminal {"command":"npx tsc --noEmit"}', { status: "completed", summary: "(no output)" }, 10);
    ledger.observe("terminal", 'terminal {"command":"npm test"}', { status: "completed", summary: "1 failed\n[exit code 1]" }, 20);
    expect(ledger.all()).toEqual([
      { command: ["npx", "tsc", "--noEmit"], exitCode: 0, at: 10 },
      { command: ["npm", "test"], exitCode: 1, at: 20 },
    ]);
  });
});
