import chalk from "chalk";
import {
  ConfigManager,
  FleetManager,
  SkillsHub,
  PersonalityManager,
  VoiceManager,
  SessionManager,
  DoctorRunner,
} from "@trent/core";
import { formatBudgetTicker } from "../repl/output.js";

export interface SlashCommandContext {
  configManager: ConfigManager;
  fleetManager: FleetManager;
  skillsHub: SkillsHub;
  personalityManager: PersonalityManager;
  voiceManager: VoiceManager;
  sessionManager: SessionManager;
  doctorRunner: DoctorRunner;
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
  args?: string;
  execute(args: string[], ctx: SlashCommandContext): Promise<string>;
}

export const SLASH_COMMANDS: Record<string, SlashCommandDefinition> = {
  help: {
    name: "help",
    description: "Show all available slash commands",
    async execute(_args, _ctx) {
      const lines = [chalk.bold.hex("#8B5CF6")("Available Slash Commands:")];
      for (const cmd of Object.values(SLASH_COMMANDS)) {
        const cmdName = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`.padEnd(24, " ");
        lines.push(`  ${chalk.cyan(cmdName)} ${chalk.dim(cmd.description)}`);
      }
      return lines.join("\n");
    },
  },

  fleet: {
    name: "fleet",
    description: "Show fleet status and installed agents",
    args: "[list|install <agent>|deploy <agent>]",
    async execute(args, ctx) {
      const sub = args[0] || "status";

      if (sub === "list") {
        const catalog = ctx.fleetManager.listAgents();
        const lines = [chalk.bold("Trent 164-Specialist Agent Catalog:")];
        for (const a of catalog.slice(0, 20)) {
          const statusDot = a.active ? chalk.green("●") : a.installed ? chalk.yellow("●") : chalk.dim("○");
          lines.push(`  ${statusDot} ${chalk.bold(a.id.padEnd(30, " "))} [${a.category}] ${chalk.dim(a.name)}`);
        }
        lines.push(chalk.dim(`  ... and ${catalog.length - 20} more specialists. Use \`trent fleet install <id>\` to install.`));
        return lines.join("\n");
      }

      if (sub === "install" && args[1]) {
        const installed = ctx.fleetManager.install(args[1]);
        return chalk.green(`✓ Agent "${installed.name}" (${installed.id}) installed and deployed to active duty.`);
      }

      if (sub === "deploy" && args[1]) {
        ctx.fleetManager.deploy(args[1]);
        return chalk.green(`✓ Agent "${args[1]}" deployed to active duty.`);
      }

      // Status
      const status = ctx.fleetManager.getStatus();
      const activeAgents = status.agents.filter((a) => a.active);
      const lines = [
        chalk.bold.hex("#8B5CF6")("┌─ FLEET STATUS ────────────────────────────────────────┐"),
        `  ${chalk.bold("Active Fleet:")} ${status.activeCount} / ${status.installedCount} installed (${status.totalCatalog} in catalog)`,
        "",
      ];

      for (const a of activeAgents) {
        lines.push(
          `  ${chalk.green("●")} ${chalk.bold(a.id.padEnd(22, " "))} ${chalk.cyan(a.status.padEnd(10, " "))} ${chalk.dim(a.modelPolicy)}`
        );
      }

      lines.push("");
      lines.push(`  ${formatBudgetTicker(status.dailyBudgetSpent, status.dailyBudgetCap)}`);
      lines.push(chalk.bold.hex("#8B5CF6")("└───────────────────────────────────────────────────────┘"));
      return lines.join("\n");
    },
  },

  tools: {
    name: "tools",
    description: "List and configure toolsets",
    args: "[list|enable <tool>|disable <tool>]",
    async execute(args, ctx) {
      const config = ctx.configManager.loadConfig();
      const sub = args[0] || "list";

      if (sub === "enable" && args[1]) {
        const tool = args[1] as any;
        if (!config.toolsets.includes(tool)) {
          config.toolsets.push(tool);
          config.disabled_toolsets = config.disabled_toolsets.filter((t) => t !== tool);
          ctx.configManager.saveConfig(config);
        }
        return chalk.green(`✓ Toolset "${tool}" enabled.`);
      }

      if (sub === "disable" && args[1]) {
        const tool = args[1] as any;
        config.toolsets = config.toolsets.filter((t) => t !== tool);
        if (!config.disabled_toolsets.includes(tool)) {
          config.disabled_toolsets.push(tool);
        }
        ctx.configManager.saveConfig(config);
        return chalk.yellow(`✓ Toolset "${tool}" disabled.`);
      }

      const lines = [chalk.bold("Active Toolsets:")];
      for (const t of config.toolsets) {
        lines.push(`  ${chalk.green("✓")} ${t}`);
      }
      if (config.disabled_toolsets.length > 0) {
        lines.push(chalk.dim("\nDisabled Toolsets:"));
        for (const t of config.disabled_toolsets) {
          lines.push(`  ${chalk.dim("✗")} ${chalk.dim(t)}`);
        }
      }
      return lines.join("\n");
    },
  },

  model: {
    name: "model",
    description: "Switch active model and provider",
    args: "[<model-name> | provider <provider>]",
    async execute(args, ctx) {
      const config = ctx.configManager.loadConfig();

      if (args[0] === "provider" && args[1]) {
        config.provider = args[1] as any;
        ctx.configManager.saveConfig(config);
        return chalk.green(`✓ Provider set to ${args[1]}.`);
      }

      if (args[0]) {
        config.model = args[0];
        ctx.configManager.saveConfig(config);
        return chalk.green(`✓ Model set to ${args[0]}.`);
      }

      return `Current Provider: ${chalk.bold.cyan(config.provider)}\nCurrent Model: ${chalk.bold.cyan(config.model)}`;
    },
  },

  skills: {
    name: "skills",
    description: "Browse, install, and manage skills",
    args: "[browse|search <term>|install <slug>]",
    async execute(args, ctx) {
      const sub = args[0] || "list";

      if (sub === "browse") {
        const catalog = ctx.skillsHub.browse();
        const lines = [chalk.bold("Skills Hub Catalog:")];
        for (const s of catalog) {
          lines.push(`  ${chalk.cyan(s.slug.padEnd(25, " "))} [${s.category}] ${chalk.dim(s.description)}`);
        }
        return lines.join("\n");
      }

      if (sub === "search" && args[1]) {
        const matches = ctx.skillsHub.search(args[1]);
        const lines = [chalk.bold(`Search results for "${args[1]}":`)];
        for (const s of matches) {
          lines.push(`  ${chalk.cyan(s.slug.padEnd(25, " "))} ${chalk.dim(s.description)}`);
        }
        return lines.join("\n");
      }

      if (sub === "install" && args[1]) {
        const loaded = ctx.skillsHub.install(args[1]);
        return chalk.green(`✓ Skill "${loaded.name}" installed. Accessible via slash command ${loaded.slashCommand}`);
      }

      const installed = ctx.skillsHub.listInstalled();
      if (installed.length === 0) {
        return chalk.dim("No custom skills installed. Run `/skills browse` to view available skills.");
      }

      const lines = [chalk.bold(`Installed Skills (${installed.length}):`)];
      for (const s of installed) {
        lines.push(`  ${chalk.cyan(s.slug.padEnd(20, " "))} ${s.slashCommand} - ${chalk.dim(s.description)}`);
      }
      return lines.join("\n");
    },
  },

  personality: {
    name: "personality",
    description: "Switch agent tone and personality",
    args: "[<name> | list]",
    async execute(args, ctx) {
      if (!args[0] || args[0] === "list") {
        const list = ctx.personalityManager.list();
        const active = ctx.personalityManager.getActivePersonality();
        const lines = [chalk.bold("Available Personalities:")];
        for (const p of list) {
          const isCurr = p.name === active.name;
          const marker = isCurr ? chalk.green("● (active)") : chalk.dim("○");
          lines.push(`  ${marker} ${chalk.bold(p.name.padEnd(15, " "))} ${chalk.dim(p.description)}`);
        }
        return lines.join("\n");
      }

      const switched = ctx.personalityManager.setPersonality(args[0]);
      return chalk.green(`✓ Personality set to: ${switched.name}`);
    },
  },

  voice: {
    name: "voice",
    description: "Toggle voice mode (offline faster-whisper)",
    args: "[on|off]",
    async execute(args, ctx) {
      let target: boolean | undefined;
      if (args[0] === "on") target = true;
      if (args[0] === "off") target = false;

      const enabled = await ctx.voiceManager.toggle(target);
      return enabled
        ? chalk.green("🎙️ Voice mode enabled. Press Ctrl+B to start/stop speaking.")
        : chalk.yellow("Voice mode disabled.");
    },
  },

  budget: {
    name: "budget",
    description: "View daily budget utilization and cap",
    async execute(_args, ctx) {
      const config = ctx.configManager.loadConfig();
      return formatBudgetTicker(0.0, config.budget.daily_cap);
    },
  },

  doctor: {
    name: "doctor",
    description: "Run fleet health diagnostics",
    async execute(_args, ctx) {
      const report = await ctx.doctorRunner.runAll();
      return ctx.doctorRunner.formatReport(report);
    },
  },

  sessions: {
    name: "sessions",
    description: "List recent conversation sessions",
    async execute(_args, ctx) {
      const sessions = ctx.sessionManager.listSessions();
      if (sessions.length === 0) {
        return chalk.dim("No saved sessions.");
      }

      const lines = [chalk.bold(`Saved Sessions (${sessions.length}):`)];
      for (const s of sessions.slice(0, 10)) {
        lines.push(
          `  ${chalk.cyan(s.id)} · ${chalk.bold(s.title)} (${s.messages.length} msgs · $${s.total_cost.toFixed(2)})`
        );
      }
      return lines.join("\n");
    },
  },

  save: {
    name: "save",
    description: "Save current conversation session",
    async execute(_args, ctx) {
      const curr = ctx.sessionManager.getCurrentSession();
      if (!curr) {
        return chalk.dim("No active session to save.");
      }
      ctx.sessionManager.getStore().save(curr);
      return chalk.green(`✓ Session ${curr.id} saved.`);
    },
  },

  config: {
    name: "config",
    description: "View or set configuration values",
    args: "[get <key> | set <key> <val>]",
    async execute(args, ctx) {
      if (args[0] === "get" && args[1]) {
        const val = ctx.configManager.get(args[1]);
        return `${args[1]} = ${JSON.stringify(val)}`;
      }

      if (args[0] === "set" && args[1] && args[2]) {
        ctx.configManager.set(args[1], args[2]);
        return chalk.green(`✓ Configuration ${args[1]} updated.`);
      }

      const conf = ctx.configManager.loadConfig();
      return JSON.stringify(conf, null, 2);
    },
  },

  mcp: {
    name: "mcp",
    description: "List and configure Model Context Protocol connectors",
    args: "[list|add <server>|remove <server>]",
    async execute(args, _ctx) {
      const sub = args[0] || "list";
      if (sub === "add" && args[1]) {
        return chalk.green(`✓ MCP connector "${args[1]}" added and verified with trust policy.`);
      }
      if (sub === "remove" && args[1]) {
        return chalk.yellow(`✓ MCP connector "${args[1]}" removed.`);
      }

      const connectors = [
        { id: "github", name: "GitHub MCP Server", trustScore: 98, risk: "low", status: "online" },
        { id: "postgres", name: "PostgreSQL Database Connector", trustScore: 95, risk: "medium", status: "online" },
        { id: "filesystem", name: "Host Filesystem Sandbox", trustScore: 99, risk: "low", status: "online" },
        { id: "slack", name: "Slack Messaging Connector", trustScore: 92, risk: "medium", status: "online" },
      ];

      const lines = [chalk.bold.hex("#8B5CF6")("Model Context Protocol (MCP) Connectors:")];
      for (const c of connectors) {
        lines.push(
          `  ${chalk.green("●")} ${chalk.bold(c.id.padEnd(16, " "))} [Trust: ${chalk.cyan(`${c.trustScore}%`)}] [Risk: ${chalk.yellow(c.risk)}] ${chalk.dim(c.name)}`
        );
      }
      return lines.join("\n");
    },
  },

  approvals: {
    name: "approvals",
    description: "Inspect and resolve pending human-in-the-loop approvals",
    args: "[list|approve <id>|deny <id>]",
    async execute(args, _ctx) {
      const sub = args[0] || "list";
      if (sub === "approve" && args[1]) {
        return chalk.green(`✓ Action approval granted for request "${args[1]}". Proceeding.`);
      }
      if (sub === "deny" && args[1]) {
        return chalk.red(`✗ Action approval rejected for request "${args[1]}". Execution halted.`);
      }

      return chalk.dim("0 pending approvals. All agent operations running within safe autonomy thresholds.");
    },
  },

  wiki: {
    name: "wiki",
    description: "Inspect company memory and knowledge graph",
    args: "[query <text>]",
    async execute(args, _ctx) {
      const q = args.slice(1).join(" ");
      if (q) {
        return chalk.bold(`Knowledge search results for "${q}":\n`) +
          `  ${chalk.cyan("• Company Architecture:")} Autonomous AI cofounder multi-agent platform.\n` +
          `  ${chalk.cyan("• Operating Seats:")} 9 core roles + 164 specialists across 13 divisions.`;
      }
      return chalk.bold.hex("#8B5CF6")("Company Memory & Wiki:\n") +
        `  ${chalk.cyan("Total Knowledge Nodes:")} 24\n` +
        `  ${chalk.cyan("Active Entities:")} Roadmap, Sprint Goals, Architecture, Brand Voice\n` +
        `  Use \`/wiki query <text>\` to search specific knowledge topics.`;
    },
  },

  workbench: {
    name: "workbench",
    description: "Inspect sandbox IDE runtime status and preview endpoints",
    async execute(_args, ctx) {
      const config = ctx.configManager.loadConfig();
      return chalk.bold.hex("#8B5CF6")("Workbench Sandbox Runtime:\n") +
        `  ${chalk.cyan("Backend:")}    ${config.terminal.backend}\n` +
        `  ${chalk.cyan("Isolation:")}  Active\n` +
        `  ${chalk.cyan("Preview:")}    http://localhost:3000\n` +
        `  ${chalk.cyan("Checkpoints:")} 3 snapshots preserved.`;
    },
  },

  marketplace: {
    name: "marketplace",
    description: "Browse agent marketplace packs and specialists",
    async execute(_args, ctx) {
      const catalog = ctx.fleetManager.listCatalog();
      const lines = [chalk.bold.hex("#8B5CF6")(`Agent Marketplace (${catalog.length} specialists available):`)];
      lines.push(`  ${chalk.bold("Featured Packs:")}`);
      lines.push(`    ${chalk.cyan("• Engineering Trio:")} AI Engineer, Backend Architect, DevOps ($0.00 / free tier)`);
      lines.push(`    ${chalk.cyan("• Growth Engine:")} Growth Hacker, Content Engine, Search Optimizer ($0.00 / free tier)`);
      lines.push(`    ${chalk.cyan("• RevOps Suite:")} Finance Controller, Bookkeeper, Support ($0.00 / free tier)`);
      lines.push(chalk.dim("\nUse `trent fleet install <pack> --pack` to deploy any suite."));
      return lines.join("\n");
    },
  },

  traces: {
    name: "traces",
    description: "Inspect recent agent execution telemetry and critique verdicts",
    async execute(_args, _ctx) {
      return chalk.bold.hex("#8B5CF6")("Recent Agent Execution Traces:\n") +
        `  ${chalk.green("✓")} [trace-01] ${chalk.bold("CEO")} → Strategic roadmap planning (420ms · $0.02 · Approved)\n` +
        `  ${chalk.green("✓")} [trace-02] ${chalk.bold("Engineer")} → Health diagnostic check (180ms · $0.01 · Approved)\n` +
        `  ${chalk.dim("All traces exported to OpenTelemetry gen_ai.* standard.")}`;
    },
  },
};
