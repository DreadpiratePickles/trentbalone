/**
 * The `fleet` and `skills` groups. Both read the real catalogs and the real installed state.
 */

import { FleetManager } from "@trent/core/fleet/index.js";
import { SkillsHub } from "@trent/core/skills/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import fs from "node:fs";
import path from "node:path";
import type { CommandSpec } from "../registry.js";

const DEFAULT_BUDGET_USD = "1.0";

export const fleetSpec: CommandSpec = {
  name: "fleet",
  description: "Manage the 164-specialist agent fleet",
  subcommands: [
    {
      name: "list",
      description: "List every agent in the catalog with its installed and active state",
      options: [
        { flags: "--category <category>", description: "Filter by functional category" },
        { flags: "--installed", description: "Only agents installed in this profile" },
        { flags: "--limit <n>", description: "Maximum rows in human output", defaultValue: "25" },
      ],
      run(ctx, opts) {
        const all = new FleetManager(ctx.config()).listAgents();
        const category = typeof opts.category === "string" ? opts.category : undefined;
        const agents = all
          .filter((a) => category === undefined || a.category === category)
          .filter((a) => opts.installed !== true || a.installed)
          .map((a) => ({
            id: a.id,
            name: a.name,
            category: a.category,
            status: a.status,
            installed: a.installed,
            active: a.active,
            modelPolicy: a.modelPolicy,
            toolsCount: a.toolsCount,
          }));
        return { data: { count: agents.length, total: all.length, agents } };
      },
      render(data, ctx) {
        const d = data as {
          count: number;
          total: number;
          agents: { id: string; name: string; category: string; installed: boolean; active: boolean }[];
        };
        const lines = [ctx.theme.emphasis(`FLEET CATALOG (${d.count} of ${d.total})`)];
        for (const a of d.agents.slice(0, 25)) {
          const mark = a.active
            ? ctx.theme.success("active   ")
            : a.installed
              ? ctx.theme.needsApproval("installed")
              : ctx.theme.meta("available");
          lines.push(`  ${mark} ${ctx.theme.value(a.id.padEnd(28, " "))} ${ctx.theme.body(a.name)}`);
        }
        if (d.agents.length > 25) {
          lines.push(ctx.theme.meta(`  ... ${d.agents.length - 25} more. Use --json for all.`));
        }
        return lines;
      },
    },
    {
      name: "install <agentId>",
      description: "Install an agent with its tools, skills and model policy",
      options: [{ flags: "--pack", description: "Install a whole category pack" }],
      run(ctx, opts, args) {
        const agentId = String(args[0]);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "fleet install", agentId, pack: opts.pack === true } };
        }
        const fleet = new FleetManager(ctx.config());
        if (opts.pack === true) {
          const installed = fleet.installPack(agentId);
          return { data: { pack: agentId, installed: installed.map((a) => a.id) } };
        }
        const agent = fleet.install(agentId);
        return { data: { installed: [agent.id], agent: { id: agent.id, name: agent.name } } };
      },
      render(data, ctx) {
        const d = data as { installed?: string[]; dryRun?: boolean; agentId?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would install")} ${String(d.agentId)}`];
        return [`  ${ctx.theme.success("installed")} ${ctx.theme.value((d.installed ?? []).join(", "))}`];
      },
    },
    {
      name: "deploy <agentId>",
      description: "Deploy an installed agent to active fleet duty",
      run(ctx, _opts, args) {
        const agentId = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "fleet deploy", agentId } };
        const deployed = new FleetManager(ctx.config()).deploy(agentId);
        if (!deployed) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "fleet.deploy",
            message: "agent is not installed in this profile",
            target: agentId,
          });
        }
        return { data: { agentId, deployed } };
      },
      render(data, ctx) {
        const d = data as { agentId: string };
        return [`  ${ctx.theme.success("deployed")} ${ctx.theme.value(d.agentId)}`];
      },
    },
    {
      name: "status",
      description: "Show fleet operational status and today's budget position",
      run(ctx) {
        const status = new FleetManager(ctx.config()).getStatus();
        return {
          data: {
            totalCatalog: status.totalCatalog,
            installedCount: status.installedCount,
            activeCount: status.activeCount,
            dailyBudgetSpent: status.dailyBudgetSpent,
            dailyBudgetCap: status.dailyBudgetCap,
          },
        };
      },
      render(data, ctx) {
        const d = data as {
          totalCatalog: number;
          installedCount: number;
          activeCount: number;
          dailyBudgetSpent: number;
          dailyBudgetCap: number;
        };
        return [
          ctx.theme.emphasis("FLEET STATUS"),
          `  ${ctx.theme.meta("active")} ${d.activeCount}  ${ctx.theme.meta("installed")} ${d.installedCount}  ${ctx.theme.meta("catalog")} ${d.totalCatalog}`,
          `  ${ctx.theme.meta("budget")} ${d.dailyBudgetSpent.toFixed(2)} / ${d.dailyBudgetCap.toFixed(2)}`,
        ];
      },
    },
    {
      name: "create <agentId>",
      description: "Create and register a custom cofounder agent in this profile",
      options: [
        { flags: "--name <name>", description: "Human-readable agent name" },
        { flags: "--role <role>", description: "Functional role" },
        { flags: "--category <category>", description: "Functional category", defaultValue: "specialized" },
        { flags: "--budget <usd>", description: "Per-run budget cap in USD", defaultValue: DEFAULT_BUDGET_USD },
      ],
      run(ctx, opts, args) {
        const id = String(args[0]).toLowerCase().trim();
        if (id === "") {
          throw new TrentError({
            code: EXIT.USAGE,
            operation: "fleet.create",
            message: "agent id must not be empty",
          });
        }
        const budget = Number(opts.budget ?? DEFAULT_BUDGET_USD);
        if (!Number.isFinite(budget) || budget <= 0) {
          throw new TrentError({
            code: EXIT.BUDGET,
            operation: "fleet.create",
            message: "--budget must be a positive number of USD",
            target: String(opts.budget),
          });
        }

        const manager = ctx.config();
        const file = path.join(manager.getAgentsDir(), `${id}.json`);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "fleet create", agentId: id, wouldWrite: file } };
        }

        const agent = {
          id,
          name: typeof opts.name === "string" ? opts.name : `${id} agent`,
          category: typeof opts.category === "string" ? opts.category : "specialized",
          role: typeof opts.role === "string" ? opts.role : "Custom Specialist",
          modelPolicy: "balanced",
          installed_at: new Date().toISOString(),
          active: true,
          tools: [
            { name: "file_ops", purpose: "File system operations" },
            { name: "terminal", purpose: "Sandbox terminal" },
          ],
          skills: [],
          budget_cap_per_run: budget,
        };
        manager.ensureDirs();
        fs.writeFileSync(file, JSON.stringify(agent, null, 2), "utf8");
        new FleetManager(manager).deploy(id);
        return { data: { agent, path: file, deployed: true } };
      },
      render(data, ctx) {
        const d = data as { agent?: { id: string; name: string }; dryRun?: boolean; agentId?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would create")} ${String(d.agentId)}`];
        return [`  ${ctx.theme.success("created")} ${ctx.theme.value(String(d.agent?.id))}`];
      },
    },
  ],
};

export const skillsSpec: CommandSpec = {
  name: "skills",
  description: "Browse, search, install and remove skills",
  subcommands: [
    {
      name: "browse",
      description: "Browse the skills catalog",
      run(ctx) {
        const catalog = new SkillsHub(ctx.config()).browse();
        return { data: { count: catalog.length, skills: catalog } };
      },
      render: renderSkillCatalog,
    },
    {
      name: "search <term>",
      description: "Search the skills catalog by keyword",
      run(ctx, _opts, args) {
        const term = String(args[0]);
        const matches = new SkillsHub(ctx.config()).search(term);
        return { data: { term, count: matches.length, skills: matches } };
      },
      render: renderSkillCatalog,
    },
    {
      name: "install <slug>",
      description: "Install a skill after its pre-install security scan",
      run(ctx, _opts, args) {
        const slug = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "skills install", slug } };
        const loaded = new SkillsHub(ctx.config()).install(slug);
        return {
          data: {
            slug: loaded.slug,
            name: loaded.name,
            slashCommand: loaded.slashCommand,
            installed: true,
          },
        };
      },
      render(data, ctx) {
        const d = data as { slug: string; slashCommand?: string; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would install")} ${d.slug}`];
        return [
          `  ${ctx.theme.success("installed")} ${ctx.theme.value(d.slug)} ${ctx.theme.meta(String(d.slashCommand))}`,
        ];
      },
    },
    {
      name: "remove <slug>",
      description: "Remove an installed skill",
      run(ctx, _opts, args) {
        const slug = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "skills remove", slug } };
        const removed = new SkillsHub(ctx.config()).remove(slug);
        if (!removed) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "skills.remove",
            message: "skill is not installed in this profile",
            target: slug,
          });
        }
        return { data: { slug, removed } };
      },
      render(data, ctx) {
        const d = data as { slug: string };
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.slug)}`];
      },
    },
    {
      name: "list",
      description: "List the skills installed in this profile",
      run(ctx) {
        const installed = new SkillsHub(ctx.config()).listInstalled();
        return { data: { count: installed.length, skills: installed } };
      },
      render: renderSkillCatalog,
    },
  ],
};

function renderSkillCatalog(
  data: Record<string, unknown> | unknown[],
  ctx: { theme: { emphasis: (s: string) => string; value: (s: string) => string; body: (s: string) => string } },
): string[] {
  const d = data as { count: number; skills: { slug: string; description: string }[] };
  const lines = [ctx.theme.emphasis(`SKILLS (${d.count})`)];
  for (const s of d.skills) {
    lines.push(`  ${ctx.theme.value(s.slug.padEnd(26, " "))} ${ctx.theme.body(s.description)}`);
  }
  return lines;
}
