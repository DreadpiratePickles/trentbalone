/**
 * 3.6 — slash commands, every one of them reading real state.
 *
 * The five that used to be static text — /mcp, /approvals, /wiki, /workbench, /traces —
 * now read the config, the store, the durable run index and the trace store. The test
 * for this is behavioural: mutate the state, re-run the command, and the output must
 * change.
 */

import { CHECKPOINT_COMMANDS } from "./checkpoint-commands.js";
import { GOAL_COMMANDS } from "./goal-commands.js";
import { decideHeldWrite, heldWriteLines, heldWrites } from "./held-writes.js";
import { GLYPHS, fadingRule, type Theme } from "../ui/index.js";
import { formatCents } from "./budget.js";
import { contextReport, contextReportLines } from "./context-report.js";
import { listRememberedRuns, searchRuns } from "./memory.js";
import { DEGRADED_MARK } from "./degraded.js";
import type { McpServerConfig, ReplContext } from "./types.js";

export interface ReplCommand {
  name: string;
  description: string;
  args?: string;
  run(args: string[], ctx: ReplContext): Promise<string>;
}

const WIDTH = 72;

function heading(title: string, theme: Theme): string {
  return `${theme.emphasis(title.toUpperCase())}\n${fadingRule(WIDTH, theme)}`;
}

function bullet(theme: Theme, label: string, value: string): string {
  return `  ${theme.meta(label.padEnd(12))}${theme.body(value)}`;
}

function empty(theme: Theme, text: string): string {
  return `  ${theme.meta(text)}`;
}

function mcpServers(ctx: ReplContext): McpServerConfig[] {
  const raw = (ctx.config as { mcp?: { servers?: unknown } }).mcp?.servers;
  return Array.isArray(raw) ? (raw as McpServerConfig[]) : [];
}

/** The sandbox as resolved at start; the configured backend only when nothing resolved it. */
function sandboxLabel(ctx: ReplContext): string {
  const sandbox = ctx.sandbox;
  if (sandbox === undefined) return ctx.config.terminal.backend;
  const image = sandbox.image === undefined ? "" : ` ${sandbox.image}`;
  const note = sandbox.note === undefined || sandbox.note === "configured" ? "" : ` (${sandbox.note})`;
  return `${sandbox.backend}${image}${note}`;
}

function egressLabel(ctx: ReplContext): string {
  const egress = ctx.egress;
  if (egress === undefined) return "not started";
  if (egress.state === "on") return `on, 127.0.0.1:${egress.port ?? "?"}`;
  if (egress.state === "off") return "off (network none)";
  return `failed, network none: ${egress.error ?? "unknown"}`;
}

export const REPL_COMMANDS: Record<string, ReplCommand> = {
  help: {
    name: "help",
    description: "List the commands and the key bindings",
    async run(_args, ctx) {
      const lines = [heading("commands", ctx.theme)];
      for (const command of Object.values(REPL_COMMANDS)) {
        const label = `/${command.name}${command.args === undefined ? "" : ` ${command.args}`}`;
        lines.push(`  ${ctx.theme.accent(label.padEnd(26))}${ctx.theme.body(command.description)}`);
      }
      return lines.join("\n");
    },
  },

  status: {
    name: "status",
    description: "Everything the session currently knows about itself",
    async run(_args, ctx) {
      const pending = await ctx.approvals.pending();
      return [
        heading("session", ctx.theme),
        bullet(ctx.theme, "Provider", `${ctx.config.provider} / ${ctx.config.model}`),
        bullet(ctx.theme, "Fleet", ctx.config.fleet.active_agents.join(", ") || "(none active)"),
        bullet(ctx.theme, "Sandbox", sandboxLabel(ctx)),
        bullet(ctx.theme, "Tools", (ctx.tools ?? []).map((tool) => tool.name).join(", ") || "(none registered)"),
        bullet(ctx.theme, "Egress", egressLabel(ctx)),
        bullet(ctx.theme, "Spend", ctx.budget.render(ctx.theme)),
        bullet(ctx.theme, "Approvals", `${pending.length} pending`),
        bullet(ctx.theme, "Mode", ctx.degraded ? DEGRADED_MARK : "live"),
      ].join("\n");
    },
  },

  model: {
    name: "model",
    description: "Show the provider and model this session routes to",
    async run(_args, ctx) {
      return [
        heading("model", ctx.theme),
        bullet(ctx.theme, "Provider", ctx.config.provider),
        bullet(ctx.theme, "Model", ctx.config.model),
        bullet(ctx.theme, "Per-run cap", formatCents(ctx.config.budget.per_run_cap)),
      ].join("\n");
    },
  },

  budget: {
    name: "budget",
    description: "Spend so far today, against the configured cap",
    async run(_args, ctx) {
      return [
        heading("budget", ctx.theme),
        bullet(ctx.theme, "Today", ctx.budget.render(ctx.theme)),
        bullet(ctx.theme, "Cap", formatCents(ctx.config.budget.daily_cap)),
        bullet(ctx.theme, "Alerts", ctx.config.budget.alert_thresholds.map((t) => `${t}%`).join(" · ")),
      ].join("\n");
    },
  },

  tools: {
    name: "tools",
    description: "The toolsets registered with the orchestrator, and the tool names each answers to",
    async run(_args, ctx) {
      const tools = ctx.tools ?? [];
      const lines = [heading("tools", ctx.theme)];
      lines.push(bullet(ctx.theme, "Sandbox", sandboxLabel(ctx)));
      lines.push(bullet(ctx.theme, "Egress", egressLabel(ctx)));
      if (tools.length === 0) {
        lines.push(empty(ctx.theme, "No toolset is registered. Add them under `toolsets` in config."));
        return lines.join("\n");
      }
      for (const tool of tools) {
        const names = tool.scopes.filter((scope) => scope !== tool.name);
        lines.push(
          `  ${ctx.theme.success(GLYPHS.running)} ${ctx.theme.emphasis(tool.name.padEnd(12))}${ctx.theme.body(
            names.length === 0 ? tool.name : names.join(", "),
          )}`,
        );
      }
      return lines.join("\n");
    },
  },

  mcp: {
    name: "mcp",
    description: "Model Context Protocol connectors configured for this profile",
    args: "[list]",
    async run(_args, ctx) {
      const servers = mcpServers(ctx);
      const lines = [heading("mcp connectors", ctx.theme)];
      if (servers.length === 0) {
        lines.push(empty(ctx.theme, "No connectors configured. Add them under `mcp.servers` in config."));
        return lines.join("\n");
      }
      for (const server of servers) {
        const enabled = server.enabled !== false;
        const dot = enabled ? ctx.theme.success(GLYPHS.running) : ctx.theme.meta(GLYPHS.idle);
        const target = server.url ?? server.command ?? "(no endpoint)";
        lines.push(
          `  ${dot} ${ctx.theme.emphasis(server.id.padEnd(18))}${ctx.theme.meta(
            (server.transport ?? "stdio").padEnd(8),
          )}${ctx.theme.body(target)}`,
        );
      }
      return lines.join("\n");
    },
  },

  approvals: {
    name: "approvals",
    description: "Pending human decisions — run approvals and held memory writes — and how to answer them",
    args: "[approve <id> | reject <id>]",
    async run(args, ctx) {
      const [sub, id] = args;
      const held = heldWrites();
      if ((sub === "approve" || sub === "reject") && id !== undefined) {
        // [C5 -> W3.1] A held write and a run approval are two durable paths and one command: the
        // id decides which, so a founder never has to know that one row lives in the session store
        // and the other in the profile's gateway file.
        if (held.some((row) => row.id === id)) return decideHeldWrite(ctx.theme, id, sub);
        const resolved = await ctx.approvals.answer(id, sub === "approve" ? "approved" : "rejected");
        return `  ${ctx.theme.body(`Approval ${resolved.id} ${resolved.status}.`)}`;
      }
      const pending = await ctx.approvals.pending();
      const lines = [heading("approvals", ctx.theme)];
      if (pending.length === 0 && held.length === 0) return [...lines, empty(ctx.theme, "Nothing is waiting on you.")].join("\n");
      for (const approval of pending) {
        lines.push(`  ${ctx.theme.needsApproval(GLYPHS.needsApproval)} ${ctx.theme.emphasis(approval.id)} ${ctx.theme.body(approval.action)}`);
        lines.push(`    ${ctx.theme.meta(approval.reason)}`);
      }
      lines.push(...heldWriteLines(held, ctx.theme));
      lines.push(empty(ctx.theme, "Answer with /approvals approve <id> or /approvals reject <id>."));
      return lines.join("\n");
    },
  },

  wiki: {
    name: "wiki",
    description: "Company memory: what this workspace has actually done",
    args: "[query <text>]",
    async run(args, ctx) {
      const all = await listRememberedRuns(ctx.store, ctx.companyId);
      const query = args[0] === "query" ? args.slice(1).join(" ") : args.join(" ");
      const runs = searchRuns(all, query);
      const lines = [heading(query === "" ? "company memory" : `company memory: ${query}`, ctx.theme)];
      lines.push(bullet(ctx.theme, "Runs", `${all.length} recorded, ${runs.length} matching`));
      if (runs.length === 0) {
        lines.push(empty(ctx.theme, "Nothing recorded yet. Every run you start is remembered here."));
        return lines.join("\n");
      }
      for (const { run, steps } of runs.slice(0, 10)) {
        lines.push(`  ${ctx.theme.emphasis(run.objective)} ${ctx.theme.meta(`(${run.status})`)}`);
        for (const step of steps.slice(0, 3)) {
          lines.push(`    ${ctx.theme.meta(step.agentRole.padEnd(20))}${ctx.theme.body(step.title)}`);
        }
      }
      return lines.join("\n");
    },
  },

  workbench: {
    name: "workbench",
    description: "Sandbox runtime and the jobs that have run in it",
    async run(_args, ctx) {
      const jobs = await ctx.store.listJobRuns(ctx.companyId, 100);
      const workbenchJobs = jobs.filter((job) => job.type === "workbench");
      const lines = [
        heading("workbench", ctx.theme),
        bullet(ctx.theme, "Backend", ctx.config.terminal.backend),
        bullet(ctx.theme, "Jobs", `${workbenchJobs.length} sandbox jobs, ${jobs.length} total`),
      ];
      for (const job of workbenchJobs.slice(0, 5)) {
        lines.push(`  ${ctx.theme.meta(job.id.padEnd(24))}${ctx.theme.body(job.status)}`);
      }
      if (workbenchJobs.length === 0) {
        lines.push(empty(ctx.theme, "No sandbox job has run in this workspace yet."));
      }
      return lines.join("\n");
    },
  },

  context: {
    name: "context",
    description: "What the wrapper injected into the last seat call: tier sizes, the ceiling and what it dropped",
    async run(_args, ctx) {
      const report = contextReport({ inspector: ctx.contextInspector, runs: ctx.contextRuns, compactions: ctx.compactions });
      const lines = [heading("context", ctx.theme)];
      for (const line of contextReportLines(report)) {
        lines.push(line.startsWith("  ") ? `  ${ctx.theme.meta(line.slice(2, 12))}${ctx.theme.body(line.slice(12))}` : `  ${ctx.theme.body(line)}`);
      }
      return lines.join("\n");
    },
  },

  fleet: {
    name: "fleet",
    description: "The seats and specialists this profile has installed, and what they cost today",
    async run(_args, ctx) {
      const lines = [heading("fleet", ctx.theme)];
      if (ctx.fleet === undefined) {
        lines.push(empty(ctx.theme, "This session has no fleet view; run `trent fleet list` instead."));
        return lines.join("\n");
      }
      const status = ctx.fleet.getStatus();
      lines.push(bullet(ctx.theme, "Active", `${status.activeCount} of ${status.installedCount} installed, ${status.totalCatalog} in the catalog`));
      lines.push(bullet(ctx.theme, "Today", `${formatCents(status.dailyBudgetSpentCents)} of ${formatCents(status.dailyBudgetCapCents)}`));
      const active = status.agents.filter((agent) => agent.active);
      if (active.length === 0) {
        lines.push(empty(ctx.theme, "No agent is active. `trent fleet install <id>` installs one."));
        return lines.join("\n");
      }
      for (const agent of active) {
        lines.push(
          `  ${ctx.theme.success(GLYPHS.running)} ${ctx.theme.emphasis(agent.id.padEnd(22))}${ctx.theme.meta(agent.status.padEnd(10))}${ctx.theme.body(agent.modelPolicy)}`,
        );
      }
      return lines.join("\n");
    },
  },

  skills: {
    name: "skills",
    description: "Skills installed for this profile, and the hub catalog",
    args: "[browse | search <term>]",
    async run(args, ctx) {
      const lines = [heading("skills", ctx.theme)];
      if (ctx.skills === undefined) {
        lines.push(empty(ctx.theme, "This session has no skills view; run `trent skills list` instead."));
        return lines.join("\n");
      }
      const [sub, ...rest] = args;
      if (sub === "browse" || sub === "search") {
        const term = rest.join(" ");
        const rows = sub === "browse" ? ctx.skills.browse() : ctx.skills.search(term);
        lines.push(bullet(ctx.theme, "Catalog", `${rows.length} skill(s)${term === "" ? "" : ` matching ${term}`}`));
        for (const row of rows) lines.push(`  ${ctx.theme.emphasis(row.slug.padEnd(24))}${ctx.theme.body(row.description)}`);
        if (rows.length === 0) lines.push(empty(ctx.theme, "Nothing in the catalog matches that."));
        return lines.join("\n");
      }
      const installed = ctx.skills.listInstalled();
      lines.push(bullet(ctx.theme, "Installed", `${installed.length}`));
      for (const skill of installed) {
        lines.push(`  ${ctx.theme.emphasis(skill.slug.padEnd(20))}${ctx.theme.meta(skill.slashCommand.padEnd(20))}${ctx.theme.body(skill.description)}`);
      }
      if (installed.length === 0) lines.push(empty(ctx.theme, "No skill is installed. /skills browse lists the hub."));
      return lines.join("\n");
    },
  },

  personality: {
    name: "personality",
    description: "The tone stance appended to every seat prompt, and the others this profile can use",
    args: "[<name>]",
    async run(args, ctx) {
      const lines = [heading("personality", ctx.theme)];
      if (ctx.personalities === undefined) {
        lines.push(empty(ctx.theme, "This session has no personality view; run `trent config set personality <name>` instead."));
        return lines.join("\n");
      }
      const wanted = args[0];
      if (wanted !== undefined && wanted !== "list") {
        const switched = ctx.personalities.setPersonality(wanted);
        lines.push(bullet(ctx.theme, "Set", switched.name));
        // The suffix is read once, when the session's fleet-memory hook is built, so saying it
        // applies now would be a lie: it applies to the next session.
        lines.push(empty(ctx.theme, "The next session's seat prompts carry it; this one keeps the stance it opened with."));
        return lines.join("\n");
      }
      const active = ctx.personalities.getActivePersonality();
      for (const personality of ctx.personalities.list()) {
        const here = personality.name === active.name;
        const dot = here ? ctx.theme.success(GLYPHS.running) : ctx.theme.meta(GLYPHS.idle);
        lines.push(`  ${dot} ${ctx.theme.emphasis(personality.name.padEnd(14))}${ctx.theme.body(personality.description)}`);
      }
      return lines.join("\n");
    },
  },

  sessions: {
    name: "sessions",
    description: "Saved conversations for this profile, newest first",
    async run(_args, ctx) {
      const lines = [heading("sessions", ctx.theme)];
      if (ctx.sessions === undefined) {
        lines.push(empty(ctx.theme, "This session has no session store; run `trent sessions list` instead."));
        return lines.join("\n");
      }
      const saved = ctx.sessions.listSessions();
      lines.push(bullet(ctx.theme, "Saved", `${saved.length}`));
      for (const session of saved.slice(0, 10)) {
        lines.push(
          `  ${ctx.theme.meta(session.id.padEnd(22))}${ctx.theme.emphasis(session.title)} ${ctx.theme.body(
            `${session.messages.length} message(s), ${formatCents(session.total_cost_cents)}`,
          )}`,
        );
      }
      if (saved.length === 0) lines.push(empty(ctx.theme, "Nothing saved yet. Every turn you take is written to one."));
      return lines.join("\n");
    },
  },

  // [E1] `/checkpoints` and `/rollback` (./checkpoint-commands.ts, docs/checkpoints.md).
  ...CHECKPOINT_COMMANDS,

  traces: {
    name: "traces",
    description: "Execution telemetry recorded for this company",
    args: "[<task-type>]",
    async run(args, ctx) {
      const traces = await ctx.traces.query(ctx.companyId, args[0]);
      const lines = [heading("traces", ctx.theme)];
      if (traces.length === 0) {
        lines.push(empty(ctx.theme, "No traces recorded yet."));
        return lines.join("\n");
      }
      const total = traces.reduce((sum, trace) => sum + trace.costCents, 0);
      lines.push(bullet(ctx.theme, "Recorded", `${traces.length} steps, ${formatCents(total)} total`));
      for (const trace of traces.slice(0, 10)) {
        const done = trace.status === "completed";
        const dot = done ? ctx.theme.success(GLYPHS.done) : ctx.theme.error(GLYPHS.failed);
        lines.push(
          `  ${dot} ${ctx.theme.meta(trace.id.padEnd(14))}${ctx.theme.emphasis(trace.agentRole.padEnd(18))}${ctx.theme.body(
            trace.stepTitle,
          )} ${ctx.theme.meta(formatCents(trace.costCents))}`,
        );
      }
      return lines.join("\n");
    },
  },
  // [D4] `/goal` and `/goals` (./goal-commands.ts, docs/goals.md).
  ...GOAL_COMMANDS,

  exit: {
    name: "exit",
    description: "End this session, as Ctrl+D does",
    async run(_args, ctx) {
      // P2-5a: there was no way to leave by command. The port is the same `exit(0)` Ctrl+D calls.
      if (ctx.session === undefined) return empty(ctx.theme, "This surface has no session to end from a command; press Ctrl+D.");
      if (ctx.session.end() === "busy") return empty(ctx.theme, "A run is in flight: /stop it (or press Ctrl+C), then /exit.");
      return empty(ctx.theme, "Session ended.");
    },
  },
};

export function commandNames(): string[] {
  return Object.keys(REPL_COMMANDS);
}

/** Runs one command by name. An unknown name is reported, never thrown. */
export async function runCommand(name: string, args: string[], ctx: ReplContext): Promise<string> {
  const command = REPL_COMMANDS[name.toLowerCase()];
  if (command === undefined) {
    return `  ${ctx.theme.error(`Unknown command: /${name}`)} ${ctx.theme.meta("Type /help for the list.")}`;
  }
  return command.run(args, ctx);
}
