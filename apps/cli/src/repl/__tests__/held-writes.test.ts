/**
 * [W3.1 item 2] `/approvals` decides a held memory write, not only a run approval.
 *
 * The two live on different durable paths — a run approval is an `ApprovalRow` in the session
 * store behind `ApprovalGate`, a held untrusted write is an `ApprovalRow` in the profile's
 * `gateway.json` — and a founder should not have to know that. One command lists both and decides
 * either, and the held write's line says what it is: the kind of write, the seat that made it and
 * the untrusted tools whose output it is derived from.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { closeHeldWriteSession, holdMemoryWrite, listHeldMemoryWrites, openHeldWriteSession } from "@trent/core/tools/index.js";
import { createMemoryAdapter } from "@trent/core/tools/memory/index.js";
import { createTheme } from "../../ui/index.js";
import { runCommand } from "../commands.js";
import { BudgetLedger } from "../budget.js";
import { ApprovalGate } from "../approvals.js";
import type { ReplContext } from "../types.js";
import { MemoryStore } from "./harness.js";

const COMPANY = "cmp_held";
const ACTION = 'memory {"action":"add","content":"the vendor page lists net-30 terms"}';

let profileDir = "";

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-repl-held-"));
  openHeldWriteSession({ profileDir, memory: createMemoryAdapter({ profileDir }) });
});

afterEach(() => {
  closeHeldWriteSession();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function context(): ReplContext {
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
  } as unknown as ReplContext;
}

function hold(sources: readonly string[] = ["web_extract"]): string {
  return holdMemoryWrite({ profileDir, adapter: "memory", action: ACTION, sources, seat: "finance", runId: "run-1" }).id;
}

function blockText(): string {
  const file = path.join(profileDir, "memories", "MEMORY.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("/approvals and held memory writes", () => {
  it("lists a held write beside the run approvals, naming its kind, seat and untrusted tools", async () => {
    const id = hold(["web_extract", "browser_get_text"]);
    const ctx = context();
    await ctx.approvals.open({ action: "deploy the billing worker", reason: "it touches production", agentRole: "engineer" });

    const out = await runCommand("approvals", [], ctx);

    expect(out).toContain(id);
    expect(out).toContain("finance");
    expect(out).toContain("memory");
    expect(out).toContain("web_extract");
    expect(out).toContain("browser_get_text");
    // The run approval is still listed; the held write is an addition, not a replacement.
    expect(out).toContain("deploy the billing worker");
  });

  it("approve on a held id writes the entry with its provenance and clears the hold", async () => {
    const id = hold();

    const out = await runCommand("approvals", ["approve", id], context());

    expect(out).toContain(id);
    expect(blockText()).toContain("net-30 terms");
    expect(blockText()).toContain("[provenance: untrusted via web_extract]");
    expect(listHeldMemoryWrites(profileDir)).toHaveLength(0);
  });

  it("reject on a held id discards it, and the block is never touched", async () => {
    const id = hold();

    const out = await runCommand("approvals", ["reject", id], context());

    expect(out).toContain(id);
    expect(blockText()).toBe("");
    expect(listHeldMemoryWrites(profileDir)).toHaveLength(0);
  });

  it("an id that is not a held write still goes to the run approval gate", async () => {
    const ctx = context();
    const card = await ctx.approvals.open({ action: "deploy the billing worker", reason: "it touches production", agentRole: "engineer" });
    hold();

    const out = await runCommand("approvals", ["approve", card.id], ctx);

    expect(out).toContain(card.id);
    // The held write is untouched: deciding one is never deciding the other.
    expect(listHeldMemoryWrites(profileDir)).toHaveLength(1);
  });
});
