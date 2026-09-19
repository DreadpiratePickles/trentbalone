/**
 * E1 item 3 — `/checkpoints` and `/rollback` in the REPL.
 *
 * Same governing assertion as the rest of the command suite: mutate the state, re-run the
 * command, and the output must change. Here the state is a real ledger on a real temporary
 * workspace, so `/rollback` is asserted by what is on disk afterwards, not by what it printed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { closeCheckpointSession, openCheckpointSession, type CheckpointSession } from "@trent/core/checkpoints/index.js";
import { createTheme } from "../../ui/index.js";
import { ApprovalGate } from "../approvals.js";
import { BudgetLedger } from "../budget.js";
import { runCommand } from "../commands.js";
import type { ReplContext } from "../types.js";
import { MemoryStore } from "./harness.js";

const COMPANY = "cmp_ckpt";

let workspace = "";
let profileDir = "";
let session: CheckpointSession;
let ctx: ReplContext;

const file = (relative: string): string => path.join(workspace, relative);

/** Records the write and performs it, exactly as the `file_ops` hook does. */
function agentWrite(relative: string, content: string): void {
  const target = file(relative);
  const before = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
  session.record({ tool: "write_file", path: relative, before, after: Buffer.from(content) });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeContext(checkpoints: ReplContext["checkpoints"]): ReplContext {
  const store = new MemoryStore();
  const config: TrentConfig = structuredClone(DEFAULT_CONFIG);
  return {
    theme: createTheme("none"),
    config,
    store,
    companyId: COMPANY,
    traces: { query: async () => [], byRun: async () => [] },
    budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
    approvals: new ApprovalGate(store, COMPANY),
    degraded: false,
    checkpoints,
  };
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-repl-ckpt-"));
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  session = openCheckpointSession({ runId: "sess_repl", workspace, profileDir, seat: "engineer" });
  ctx = makeContext(session);
});

afterEach(() => {
  closeCheckpointSession();
});

describe("/checkpoints", () => {
  it("reads the live ledger: empty, then one line per turn with the files it touched", async () => {
    const before = await runCommand("checkpoints", [], ctx);
    expect(before).toMatch(/nothing/i);
    expect(before).not.toContain("a.txt");

    session.beginTurn();
    agentWrite("a.txt", "a one\n");
    session.beginTurn();
    agentWrite("b.txt", "b two\n");
    agentWrite("c.txt", "c two\n");

    const after = await runCommand("checkpoints", [], ctx);
    expect(after).not.toBe(before);
    expect(after).toContain("sess_repl");
    expect(after).toContain("a.txt");
    expect(after).toContain("b.txt, c.txt");
  });

  it("says so when the session has no ledger at all", async () => {
    closeCheckpointSession();
    const out = await runCommand("checkpoints", [], makeContext(undefined));
    expect(out).toMatch(/no checkpoint/i);
  });

  /**
   * The seam the headless runtime relies on: it opens the session on the PROCESS, the same way
   * `file_ops` finds it, so neither the engine nor `repl/index.ts` has to thread a port through.
   */
  it("falls back to the session the runtime opened when no port is wired", async () => {
    const bare = makeContext(undefined);
    session.beginTurn();
    agentWrite("a.txt", "a one\n");

    expect(await runCommand("checkpoints", [], bare)).toContain("a.txt");
    const rolled = await runCommand("rollback", [], bare);
    expect(rolled).toContain("a.txt");
    expect(fs.existsSync(file("a.txt"))).toBe(false);
  });
});

describe("/rollback", () => {
  beforeEach(() => {
    fs.writeFileSync(file("a.txt"), "a original\n");
    fs.writeFileSync(file("b.txt"), "b original\n");
    session.beginTurn();
    agentWrite("a.txt", "a one\n");
    session.beginTurn();
    agentWrite("b.txt", "b two\n");
    agentWrite("c.txt", "c two\n");
  });

  it("undoes the last turn by default, byte-exact, and names what it restored", async () => {
    const out = await runCommand("rollback", [], ctx);
    expect(out).toContain("b.txt");
    expect(out).toContain("c.txt");
    expect(fs.readFileSync(file("b.txt"), "utf8")).toBe("b original\n");
    expect(fs.existsSync(file("c.txt"))).toBe(false);
    expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("a one\n");
  });

  it("undoes a named turn and everything after it", async () => {
    await runCommand("rollback", ["1"], ctx);
    expect(fs.readFileSync(file("a.txt"), "utf8")).toBe("a original\n");
    expect(fs.readFileSync(file("b.txt"), "utf8")).toBe("b original\n");
    expect(fs.existsSync(file("c.txt"))).toBe(false);
  });

  it("refuses a file edited since the agent wrote it, until --force", async () => {
    fs.writeFileSync(file("b.txt"), "a human edited this\n");
    const refused = await runCommand("rollback", [], ctx);
    expect(refused).toMatch(/changed on disk/);
    expect(refused).toMatch(/--force/);
    expect(fs.readFileSync(file("b.txt"), "utf8")).toBe("a human edited this\n");
    expect(fs.readFileSync(file("c.txt"), "utf8")).toBe("c two\n");

    const forced = await runCommand("rollback", ["--force"], ctx);
    expect(forced).toContain("b.txt");
    expect(fs.readFileSync(file("b.txt"), "utf8")).toBe("b original\n");
  });

  it("refuses a turn that is not a number instead of rolling back something else", async () => {
    const out = await runCommand("rollback", ["yesterday"], ctx);
    expect(out).toMatch(/turn/i);
    expect(fs.readFileSync(file("c.txt"), "utf8")).toBe("c two\n");
  });
});
