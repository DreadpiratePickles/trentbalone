/**
 * 3.6 — every slash command reads real state.
 *
 * The governing assertion: mutate the underlying state, re-run the command, and the
 * output must CHANGE. A command whose output is identical before and after a state
 * change is static text wearing a command's clothes, and fails here.
 *
 * The five that used to be static text are covered individually: /mcp, /approvals,
 * /wiki, /workbench, /traces.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTheme } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { REPL_COMMANDS, runCommand, commandNames } from "../commands.js";
import { BudgetLedger } from "../budget.js";
import { ApprovalGate } from "../approvals.js";
import { rememberRun } from "../memory.js";
import type { ReplContext, ReplTraceStore, TraceRow } from "../types.js";
import { MemoryStore } from "./harness.js";

const COMPANY = "cmp_cmd";

/**
 * A trace store standing in for `InMemoryTraceStore`. The real one is exercised in
 * packages/trent-core; here the port is what matters, and importing the wrapper would
 * drag the apps/web trace module into this suite.
 */
class FakeTraceStore implements ReplTraceStore {
  readonly rows: TraceRow[] = [];
  async append(row: TraceRow): Promise<void> {
    this.rows.push(row);
  }
  async query(companyId: string, taskType?: string): Promise<TraceRow[]> {
    return this.rows.filter((r) => r.companyId === companyId && (taskType === undefined || r.taskType === taskType));
  }
  async byRun(runId: string): Promise<TraceRow[]> {
    return this.rows.filter((r) => r.runId === runId);
  }
}

function makeContext(): { ctx: ReplContext; store: MemoryStore; config: TrentConfig } {
  const store = new MemoryStore();
  const config: TrentConfig = structuredClone(DEFAULT_CONFIG);
  const ctx: ReplContext = {
    theme: createTheme("none"),
    config,
    store,
    companyId: COMPANY,
    traces: new FakeTraceStore(),
    budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
    approvals: new ApprovalGate(store, COMPANY),
    degraded: false,
  };
  return { ctx, store, config };
}

async function trace(ctx: ReplContext, id: string, cost: number): Promise<void> {
  await (ctx.traces as FakeTraceStore).append({
    id,
    companyId: COMPANY,
    runId: "run_c",
    taskType: "engineering",
    agentRole: "engineer",
    stepTitle: `step ${id}`,
    status: "completed",
    costCents: cost,
    createdAt: "2026-09-12T00:00:00.000Z",
  });
}

describe("the five commands that used to be static text", () => {
  let ctx: ReplContext;
  let store: MemoryStore;
  let config: TrentConfig;

  beforeEach(() => {
    ({ ctx, store, config } = makeContext());
  });

  it("/mcp reads the configured connectors", async () => {
    const before = await runCommand("mcp", [], ctx);
    (config as Record<string, unknown>).mcp = {
      servers: [{ id: "github", transport: "http", url: "https://example.invalid/mcp", enabled: true }],
    };
    const after = await runCommand("mcp", [], ctx);
    expect(after).not.toBe(before);
    expect(after).toContain("github");
  });

  it("/approvals reads pending approvals from the store", async () => {
    const before = await runCommand("approvals", [], ctx);
    await ctx.approvals.open({ action: "publish the post", reason: "high risk", agentRole: "marketing-writer" });
    const after = await runCommand("approvals", [], ctx);
    expect(after).not.toBe(before);
    expect(after).toContain("publish the post");

    const [pending] = await ctx.approvals.pending();
    const resolved = await runCommand("approvals", ["approve", pending!.id], ctx);
    expect(resolved).toContain(pending!.id);
    expect(await ctx.approvals.pending()).toHaveLength(0);
    expect(await runCommand("approvals", [], ctx)).not.toBe(after);
  });

  it("/wiki reads company memory out of the store", async () => {
    await store.createCompany({ id: COMPANY, name: "Test Co", slug: "test-co" });
    const before = await runCommand("wiki", [], ctx);
    await store.createRun({
      id: "run_w",
      companyId: COMPANY,
      objective: "migrate the billing ledger",
      trigger: "cli",
      status: "completed",
      modelPolicy: {},
    });
    await rememberRun(store, COMPANY, "run_w");
    const after = await runCommand("wiki", [], ctx);
    expect(after).not.toBe(before);
    expect(after).toContain("migrate the billing ledger");
    expect(await runCommand("wiki", ["query", "billing"], ctx)).toContain("migrate the billing ledger");
    expect(await runCommand("wiki", ["query", "zzzz-no-such-thing"], ctx)).not.toContain("migrate the billing ledger");
  });

  it("/workbench reads the live sandbox configuration and job history", async () => {
    const before = await runCommand("workbench", [], ctx);
    config.terminal.backend = "local";
    const afterConfig = await runCommand("workbench", [], ctx);
    expect(afterConfig).not.toBe(before);
    expect(afterConfig).toContain("local");

    await store.createJobRun({ type: "workbench", trigger: "cli", companyId: COMPANY });
    expect(await runCommand("workbench", [], ctx)).not.toBe(afterConfig);
  });

  it("/traces reads the trace store", async () => {
    const before = await runCommand("traces", [], ctx);
    await trace(ctx, "t1", 11);
    const after = await runCommand("traces", [], ctx);
    expect(after).not.toBe(before);
    expect(after).toContain("t1");

    await trace(ctx, "t2", 22);
    expect(await runCommand("traces", [], ctx)).not.toBe(after);
  });
});

describe("every command, without exception", () => {
  it("changes its output when the state it reports on changes", async () => {
    const { ctx, store, config } = makeContext();
    await store.createCompany({ id: COMPANY, name: "Test Co", slug: "test-co" });

    const before = new Map<string, string>();
    for (const name of commandNames()) before.set(name, await runCommand(name, [], ctx));

    // One broad mutation touching every state source a command may read.
    config.terminal.backend = "local";
    config.model = "gemini-3.0-pro";
    (config as Record<string, unknown>).mcp = { servers: [{ id: "fs", transport: "stdio", enabled: true }] };
    ctx.budget.record(42);
    await ctx.approvals.open({ action: "deploy", reason: "prod", agentRole: "eng-devops" });
    await store.createRun({
      id: "run_all",
      companyId: COMPANY,
      objective: "rewrite onboarding",
      trigger: "cli",
      status: "running",
      modelPolicy: {},
    });
    await rememberRun(store, COMPANY, "run_all");
    await store.createJobRun({ type: "workbench", trigger: "cli", companyId: COMPANY });
    await trace(ctx, "t9", 9);

    const unchanged: string[] = [];
    for (const name of commandNames()) {
      if (name === "help") continue; // /help documents the registry, not mutable state
      if ((await runCommand(name, [], ctx)) === before.get(name)) unchanged.push(name);
    }
    expect(unchanged).toEqual([]);
  });

  it("emits no emoji and no raw hex from any command", async () => {
    const { ctx } = makeContext();
    for (const name of commandNames()) {
      const out = await runCommand(name, [], ctx);
      expect(out, name).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(out, name).not.toMatch(/#[0-9A-Fa-f]{6}/);
    }
  });

  it("reports an unknown command instead of throwing", async () => {
    const { ctx } = makeContext();
    expect(await runCommand("definitely-not-a-command", [], ctx)).toMatch(/unknown command/i);
  });

  it("registers the five previously-static commands", () => {
    for (const name of ["mcp", "approvals", "wiki", "workbench", "traces"]) {
      expect(Object.keys(REPL_COMMANDS)).toContain(name);
    }
  });
});
