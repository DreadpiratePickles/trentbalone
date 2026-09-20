/**
 * The `fleet` group. It reads the real catalog and the real installed state. The `skills` group
 * moved to `./skills.ts`, where it shares one store with the `skills` toolset.
 */

import {
  FleetManager,
  SEAT_CAPABILITIES,
  isSeatRole,
  resolveFleetPack,
  seatCapability,
  type PackPersonaOutcome,
} from "@trent/core/fleet/index.js";
import { resolveSeatModel } from "@trent/core/orchestrator/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import fs from "node:fs";
import path from "node:path";
import type { CommandSpec } from "../registry.js";
import { fleetVersionSpecs } from "./fleet-versions.js";

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
      name: "show <seat>",
      description: "Show what makes one seat a seat: toolsets, unavailable capabilities, floor overrides, budget, model tier and eval suite",
      run(ctx, _opts, args) {
        const seat = String(args[0] ?? "").trim();
        // Same contract as every other command that takes an id (`sessions resume`, `jobs retry`,
        // `improve promote`, `fleet install`): `--dry-run` answers with a payload and exit 0,
        // reporting whether the id resolves rather than throwing. Without it the registry
        // invariant, which probes every command with a placeholder argument, cannot reach this one.
        if (ctx.dryRun) {
          return {
            data: { dryRun: true, command: "fleet show", seat, defined: isSeatRole(seat), roster: Object.keys(SEAT_CAPABILITIES) },
          };
        }
        const capability = seatCapability(seat);
        const config = ctx.config().loadConfig() as unknown as {
          provider: string;
          model: string;
          models?: { fast?: string; executor?: string; planner?: string };
        };
        return {
          data: {
            seat: capability.seat,
            name: capability.name,
            toolsets: [...capability.toolsets],
            denied: [...capability.denied],
            unavailable: capability.unavailable.map((entry) => ({ capability: entry.capability, reason: entry.reason })),
            approvalGates: [...capability.approvalGates],
            budgetCents: capability.budgetCents,
            modelTier: capability.modelTier,
            model: resolveSeatModel(seat, { provider: config.provider, model: config.model, ...(config.models ? { models: config.models } : {}) }),
            evalSuiteId: capability.evalSuiteId,
          },
        };
      },
      render(data, ctx) {
        const dry = data as { dryRun?: boolean; seat?: string; defined?: boolean };
        if (dry.dryRun === true) {
          return [
            `  ${ctx.theme.meta("would show seat")} ${ctx.theme.value(String(dry.seat))} ${dry.defined === true ? ctx.theme.success("(defined)") : ctx.theme.needsApproval("(not a seat)")}`,
          ];
        }
        const d = data as {
          seat: string;
          name: string;
          toolsets: string[];
          denied: string[];
          unavailable: { capability: string; reason: string }[];
          approvalGates: string[];
          budgetCents: number;
          modelTier: string;
          model: string;
          evalSuiteId: string;
        };
        const lines = [ctx.theme.emphasis(`SEAT ${d.seat.toUpperCase()} — ${d.name}`)];
        lines.push(`  ${ctx.theme.meta("toolsets")}     ${ctx.theme.value(d.toolsets.join(", "))}`);
        lines.push(`  ${ctx.theme.meta("denied")}       ${d.denied.length ? ctx.theme.body(d.denied.join(", ")) : ctx.theme.meta("none")}`);
        lines.push(`  ${ctx.theme.meta("unavailable")}  ${d.unavailable.length ? ctx.theme.body(d.unavailable.map((entry) => entry.capability).join(", ")) : ctx.theme.meta("none")}`);
        lines.push(`  ${ctx.theme.meta("gates")}        ${ctx.theme.body(d.approvalGates.join(", "))}`);
        lines.push(`  ${ctx.theme.meta("budget")}       ${ctx.theme.value(`${d.budgetCents} cents per run`)}`);
        lines.push(`  ${ctx.theme.meta("model")}        ${ctx.theme.value(d.model)} ${ctx.theme.meta(`(${d.modelTier} tier)`)}`);
        lines.push(`  ${ctx.theme.meta("eval suite")}   ${ctx.theme.value(d.evalSuiteId)}`);
        return lines;
      },
    },
    {
      name: "packs",
      description: "List the fleet packs: members, skills and what each one executes today",
      run(ctx) {
        const packs = new FleetManager(ctx.config()).listPacks();
        return { data: { count: packs.length, packs } };
      },
      render(data, ctx) {
        const d = data as {
          count: number;
          packs: { id: string; name: string; state: string; members: string[]; skills: string[]; installed: boolean; persona: string | null }[];
        };
        const lines = [ctx.theme.emphasis(`FLEET PACKS (${d.count})`)];
        for (const pack of d.packs) {
          const mark = pack.installed ? ctx.theme.success("installed") : ctx.theme.meta("available");
          lines.push(`  ${mark} ${ctx.theme.value(pack.id)} ${ctx.theme.body(pack.name)}`);
          lines.push(`    ${ctx.theme.meta("members")} ${ctx.theme.body(pack.members.length > 12 ? `${pack.members.length} specialists` : pack.members.join(", "))}`);
          if (pack.skills.length > 0) lines.push(`    ${ctx.theme.meta("skills")}  ${ctx.theme.body(pack.skills.join(", "))}`);
          if (pack.persona !== null) lines.push(`    ${ctx.theme.meta("persona")} ${ctx.theme.body(`brain/${pack.persona}`)}`);
          lines.push(`    ${ctx.theme.meta("state")}   ${ctx.theme.body(pack.state)}`);
        }
        return lines;
      },
    },
    {
      name: "install <agentId>",
      description: "Install an agent, or a pack: its members, its skills and its persona",
      options: [{ flags: "--pack", description: "Treat the id as a pack (needed when a seat has the same name)" }],
      run(ctx, opts, args) {
        const agentId = String(args[0]);
        const fleet = new FleetManager(ctx.config());
        // An exact pack id that names no seat or specialist is a pack without the flag; a name
        // both share (`finance`, `support`) stays the seat unless `--pack` says otherwise.
        const asPack = opts.pack === true || fleet.isPackQuery(agentId);
        if (ctx.dryRun) {
          const pack = asPack ? resolveFleetPack(agentId) : undefined;
          if (pack) {
            return {
              data: {
                dryRun: true,
                command: "fleet install",
                agentId,
                pack: true,
                members: [...pack.agents],
                skills: [...pack.skills],
                persona: fleet.listPacks().find((p) => p.id === pack.id)?.persona ?? null,
              },
            };
          }
          return { data: { dryRun: true, command: "fleet install", agentId, pack: asPack } };
        }
        if (asPack) {
          const result = fleet.installPack(agentId);
          return {
            data: {
              pack: result.pack.id,
              installed: result.agents.map((a) => a.id),
              skills: result.skills,
              persona: result.persona,
            },
          };
        }
        const agent = fleet.install(agentId);
        return { data: { installed: [agent.id], agent: { id: agent.id, name: agent.name } } };
      },
      render(data, ctx) {
        const d = data as {
          installed?: string[];
          dryRun?: boolean;
          agentId?: string;
          pack?: boolean | string;
          members?: string[];
          skills?: string[] | { installed: string[]; present: string[]; unresolved: string[] };
          persona?: string | null | PackPersonaOutcome;
        };
        if (d.dryRun === true) {
          const lines = [`  ${ctx.theme.meta("would install")} ${String(d.agentId)}`];
          if (d.members) lines.push(`  ${ctx.theme.meta("members")} ${ctx.theme.body(d.members.join(", "))}`);
          if (Array.isArray(d.skills) && d.skills.length > 0) lines.push(`  ${ctx.theme.meta("skills")}  ${ctx.theme.body(d.skills.join(", "))}`);
          if (typeof d.persona === "string") lines.push(`  ${ctx.theme.meta("persona")} ${ctx.theme.body(`brain/${d.persona}`)}`);
          return lines;
        }
        const lines = [`  ${ctx.theme.success("installed")} ${ctx.theme.value((d.installed ?? []).join(", "))}`];
        if (d.skills && !Array.isArray(d.skills)) {
          const skills = d.skills;
          if (skills.installed.length > 0) lines.push(`  ${ctx.theme.meta("skills")}  ${ctx.theme.body(skills.installed.join(", "))}`);
          if (skills.present.length > 0) lines.push(`  ${ctx.theme.meta("present")} ${ctx.theme.body(skills.present.join(", "))}`);
          if (skills.unresolved.length > 0) lines.push(`  ${ctx.theme.needsApproval("unresolved")} ${ctx.theme.body(skills.unresolved.join(", "))}`);
        }
        if (d.persona && typeof d.persona === "object") {
          const persona = d.persona;
          if (persona.status === "written" || persona.status === "unchanged") {
            const commit = persona.committed ? ", committed" : "";
            lines.push(`  ${ctx.theme.meta("persona")} ${ctx.theme.body(`brain/${persona.relativePath} (${persona.status}${commit})`)}`);
          } else if (persona.status === "disabled") {
            lines.push(`  ${ctx.theme.meta("persona")} ${ctx.theme.body("not written: brain.enabled is false in this profile")}`);
          }
        }
        return lines;
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
    ...fleetVersionSpecs,
  ],
};
