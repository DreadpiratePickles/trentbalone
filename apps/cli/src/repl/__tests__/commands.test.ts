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

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createTheme } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { REPL_COMMANDS, runCommand, commandNames } from "../commands.js";
import { BudgetLedger } from "../budget.js";
import { ApprovalGate } from "../approvals.js";
import { rememberRun } from "../memory.js";
import type { ReplContext, ReplFleetAgent, ReplTraceStore, TraceRow } from "../types.js";
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

/**
 * The live managers the commands merged out of `apps/cli/src/slash/` read, as mutable doubles.
 * `FleetManager`, `SkillsHub`, `PersonalityManager` and `SessionManager` satisfy these ports
 * structurally; the real ones are wired in `index.ts` and would drag a profile directory, the
 * agent catalog and the skills hub into this suite for nothing.
 */
interface Ports {
  agents: ReplFleetAgent[];
  spentCents: number;
  skills: { slug: string; category: string; description: string; slashCommand: string }[];
  personality: string;
  sessions: { id: string; title: string; messages: unknown[]; total_cost_cents: number }[];
}

function makeContext(): { ctx: ReplContext; store: MemoryStore; config: TrentConfig; ports: Ports } {
  const store = new MemoryStore();
  const config: TrentConfig = structuredClone(DEFAULT_CONFIG);
  const ports: Ports = { agents: [], spentCents: 0, skills: [], personality: "default", sessions: [] };
  const ctx: ReplContext = {
    theme: createTheme("none"),
    config,
    store,
    companyId: COMPANY,
    traces: new FakeTraceStore(),
    budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
    approvals: new ApprovalGate(store, COMPANY),
    degraded: false,
    contextInspector: {
      contextFor: (runId, seat) =>
        runId === "run_all" && seat === "engineer"
          ? {
              stableChars: 1200,
              contextChars: 340,
              volatileChars: 60,
              chars: 1604,
              estimatedTokens: 401,
              ceilingChars: 60_000,
              pressure: 0.0267,
              dropped: ["fleet-recall"],
              overCeiling: false,
            }
          : undefined,
    },
    contextRuns: [],
    compactions: 0,
    fleet: {
      getStatus: () => ({
        totalCatalog: 164,
        installedCount: ports.agents.filter((agent) => agent.installed).length,
        activeCount: ports.agents.filter((agent) => agent.active).length,
        dailyBudgetSpentCents: ports.spentCents,
        dailyBudgetCapCents: config.budget.daily_cap,
        agents: ports.agents,
      }),
    },
    skills: {
      browse: () => ports.skills,
      search: (term) => ports.skills.filter((skill) => skill.slug.includes(term)),
      listInstalled: () => ports.skills,
    },
    personalities: {
      list: () => [
        { name: "default", description: "the shipped stance" },
        { name: "pirate", description: "a loud stance" },
      ],
      getActivePersonality: () => ({ name: ports.personality }),
      setPersonality: (name) => {
        ports.personality = name;
        return { name };
      },
    },
    sessions: { listSessions: () => ports.sessions },
  };
  return { ctx, store, config, ports };
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
    const { ctx, store, config, ports } = makeContext();
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
    // The state the commands merged out of `apps/cli/src/slash/` read.
    ctx.contextRuns = [{ runId: "run_all", seats: ["engineer"] }];
    ctx.compactions = 2;
    ports.agents.push({ id: "eng-ai-engineer", name: "AI Engineer", category: "engineering", status: "active", modelPolicy: "balanced", installed: true, active: true });
    ports.spentCents = 42;
    ports.skills.push({ slug: "repo-audit", category: "engineering", description: "walks a repository", slashCommand: "/repo-audit" });
    ports.personality = "pirate";
    ports.sessions.push({ id: "ses_1", title: "rewrite onboarding", messages: [1, 2], total_cost_cents: 37 });

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

/**
 * Decision 5: `apps/cli/src/slash/` held a second, richer command set that nothing imported. The
 * commands there that did real work now live here, against the same live state the CLI commands
 * read — and the ones that did not (a hard-coded wiki, a marketplace of invented packs, a voice
 * transcriber whose target refuses) were not carried over.
 */
describe("the commands merged out of the dead slash module", () => {
  it("/fleet reads the installed and active agents, and today's spend in integer cents", async () => {
    const { ctx, ports } = makeContext();
    expect(await runCommand("fleet", [], ctx)).toMatch(/no agent is active/i);
    ports.agents.push({ id: "eng-ai-engineer", name: "AI Engineer", category: "engineering", status: "active", modelPolicy: "balanced", installed: true, active: true });
    ports.spentCents = 250;
    const out = await runCommand("fleet", [], ctx);
    expect(out).toContain("eng-ai-engineer");
    expect(out).toContain("164");
    expect(out).toContain("$2.50");
  });

  it("/skills lists what is installed and browses the hub", async () => {
    const { ctx, ports } = makeContext();
    expect(await runCommand("skills", [], ctx)).toMatch(/no skill is installed/i);
    ports.skills.push({ slug: "repo-audit", category: "engineering", description: "walks a repository", slashCommand: "/repo-audit" });
    expect(await runCommand("skills", [], ctx)).toContain("repo-audit");
    expect(await runCommand("skills", ["browse"], ctx)).toContain("walks a repository");
    expect(await runCommand("skills", ["search", "nothing-like-this"], ctx)).toMatch(/nothing in the catalog/i);
  });

  it("/personality marks the active stance and switches to another, saying when the switch applies", async () => {
    const { ctx, ports } = makeContext();
    expect(await runCommand("personality", [], ctx)).toContain("default");
    const switched = await runCommand("personality", ["pirate"], ctx);
    expect(ports.personality).toBe("pirate");
    // The suffix is read when the session's hook is built, so this session keeps its own.
    expect(switched).toMatch(/next session/i);
  });

  it("/sessions lists saved conversations with their cents, never a float", async () => {
    const { ctx, ports } = makeContext();
    expect(await runCommand("sessions", [], ctx)).toMatch(/nothing saved yet/i);
    ports.sessions.push({ id: "ses_1", title: "rewrite onboarding", messages: [1, 2], total_cost_cents: 37 });
    const out = await runCommand("sessions", [], ctx);
    expect(out).toContain("rewrite onboarding");
    expect(out).toContain("$0.37");
  });

  it("the dead module is gone, and nothing in the CLI imports it", () => {
    expect(fs.existsSync(path.resolve(__dirname, "../../slash"))).toBe(false);
  });
});
