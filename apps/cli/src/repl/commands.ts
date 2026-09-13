/**
 * 3.6 — slash commands, every one of them reading real state.
 *
 * The five that used to be static text — /mcp, /approvals, /wiki, /workbench, /traces —
 * now read the config, the store, the durable run index and the trace store. The test
 * for this is behavioural: mutate the state, re-run the command, and the output must
 * change.
 */

import { GLYPHS, fadingRule, type Theme } from "../ui/index.js";
import { formatCents } from "./budget.js";
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
    description: "Pending human decisions, and how to answer them",
    args: "[approve <id> | reject <id>]",
    async run(args, ctx) {
      const [sub, id] = args;
      if ((sub === "approve" || sub === "reject") && id !== undefined) {
        const resolved = await ctx.approvals.answer(id, sub === "approve" ? "approved" : "rejected");
        return `  ${ctx.theme.body(`Approval ${resolved.id} ${resolved.status}.`)}`;
      }
      const pending = await ctx.approvals.pending();
      const lines = [heading("approvals", ctx.theme)];
      if (pending.length === 0) {
        lines.push(empty(ctx.theme, "Nothing is waiting on you."));
        return lines.join("\n");
      }
      for (const approval of pending) {
        lines.push(
          `  ${ctx.theme.needsApproval(GLYPHS.needsApproval)} ${ctx.theme.emphasis(approval.id)} ${ctx.theme.body(
            approval.action,
          )}`,
        );
        lines.push(`    ${ctx.theme.meta(approval.reason)}`);
      }
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
