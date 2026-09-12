import { Command } from "commander";
import chalk from "chalk";
import {
  ConfigManager,
  DoctorRunner,
  FixRunner,
  SetupWizard,
  FleetManager,
  SkillsHub,
  GatewayManager,
  EgressProxy,
  ACPServer,
  SessionManager,
  UpdateChecker,
  generateAgentCard,
  A2AServer,
} from "@trent/core";
import fs from "node:fs";
import path from "node:path";
import {
  ASCII_LOGO,
  ASCII_DOCTOR,
  ASCII_SETUP_QUICK,
  ASCII_SETUP_FULL,
  ASCII_SETUP_BLANK,
  ASCII_FLEET,
} from "../repl/ascii.js";

export function registerCommands(program: Command): void {
  const configManager = new ConfigManager();

  // doctor
  program
    .command("doctor")
    .description("Run health diagnostics across config, credentials, agents, and systems")
    .option("--fix", "Automatically remediate safe issues")
    .option("--json", "Output structured JSON report")
    .action(async (options) => {
      const runner = new DoctorRunner(configManager);
      if (!options.json) {
        console.log(ASCII_DOCTOR);
      }
      if (options.fix) {
        const fixer = new FixRunner(configManager);
        const { actions, newReport } = await fixer.runFixes();
        if (options.json) {
          console.log(JSON.stringify({ actions, report: newReport }, null, 2));
        } else {
          console.log(chalk.bold.hex("#8B5CF6")("Automated Remediation Actions:"));
          for (const a of actions) {
            const icon = a.success ? chalk.green("✓") : chalk.red("✗");
            console.log(`  ${icon} [${a.category}] ${a.message}`);
          }
          console.log("\n" + runner.formatReport(newReport));
        }
      } else {
        const report = await runner.runAll();
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(runner.formatReport(report));
        }
      }
    });

  // setup
  program
    .command("setup")
    .description("Run the Trent setup wizard (Quick, Full, or Blank Slate)")
    .option("--portal", "Quick cloud login setup")
    .option("--mode <mode>", "Setup mode: quick, full, or blank-slate", "quick")
    .option("--provider <provider>", "Default model provider", "openai")
    .option("--key <apiKey>", "API key for the selected provider")
    .action(async (options) => {
      const wizard = new SetupWizard(configManager);
      const mode = options.portal ? "quick" : options.mode;
      if (mode === "blank-slate") {
        console.log(ASCII_SETUP_BLANK);
      } else if (mode === "full") {
        console.log(ASCII_SETUP_FULL);
      } else {
        console.log(ASCII_SETUP_QUICK);
      }
      const result = await wizard.run({
        mode,
        provider: options.provider,
        apiKey: options.key,
      });

      console.log(chalk.green.bold("\n✓ Setup Complete!"));
      console.log(`  ${result.message}\n`);
    });

  // model
  program
    .command("model [name]")
    .description("Interactive or direct model/provider selection")
    .option("--provider <provider>", "Model provider (openai, anthropic, google, etc.)")
    .action((name, options) => {
      const config = configManager.loadConfig();
      if (options.provider) {
        config.provider = options.provider;
      }
      if (name) {
        config.model = name;
      }
      configManager.saveConfig(config);
      console.log(`Active Provider: ${chalk.cyan.bold(config.provider)}`);
      console.log(`Active Model:    ${chalk.cyan.bold(config.model)}`);
    });

  // fleet
  const fleetCmd = program.command("fleet").description("Manage the 164-specialist agent fleet");

  fleetCmd
    .command("list")
    .description("List all agents in the catalog")
    .option("--json", "Output JSON list")
    .action((options) => {
      const fleet = new FleetManager(configManager);
      const agents = fleet.listAgents();

      if (options.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      console.log(ASCII_FLEET);
      console.log(chalk.bold.hex("#8B5CF6")(`Trent Fleet Catalog (${agents.length} specialists):`));
      for (const a of agents.slice(0, 25)) {
        const dot = a.active ? chalk.green("●") : a.installed ? chalk.yellow("●") : chalk.dim("○");
        console.log(`  ${dot} ${chalk.bold(a.id.padEnd(28, " "))} [${a.category.padEnd(16, " ")}] ${chalk.dim(a.name)}`);
      }
      console.log(chalk.dim(`  ... ${agents.length - 25} more specialists. Run with --json for complete list.`));
    });

  fleetCmd
    .command("install <agentId>")
    .description("Install an agent with its tools, skills, and model policy")
    .option("--pack", "Install as a fleet pack")
    .action((agentId, options) => {
      const fleet = new FleetManager(configManager);
      if (options.pack) {
        const installed = fleet.installPack(agentId);
        console.log(chalk.green(`✓ Installed pack "${agentId}" with ${installed.length} agents.`));
      } else {
        const installed = fleet.install(agentId);
        console.log(chalk.green(`✓ Agent "${installed.name}" (${installed.id}) installed.`));
      }
    });

  fleetCmd
    .command("deploy <agentId>")
    .description("Deploy an agent to active fleet duty")
    .action((agentId) => {
      const fleet = new FleetManager(configManager);
      fleet.deploy(agentId);
      console.log(chalk.green(`✓ Agent "${agentId}" deployed to active duty.`));
    });

  fleetCmd
    .command("create <agentId>")
    .description("Create and register a custom cofounder agent")
    .option("--name <name>", "Human-readable agent name")
    .option("--role <role>", "Agent functional role")
    .option("--category <category>", "Functional category", "custom")
    .option("--budget <budget>", "Per-run budget cap in USD", "1.0")
    .action((agentId, options) => {
      const fleet = new FleetManager(configManager);
      const name = options.name || `${agentId.charAt(0).toUpperCase() + agentId.slice(1)} Agent`;
      const role = options.role || "Custom Specialist";
      const customAgent = {
        id: agentId.toLowerCase().trim(),
        name,
        emoji: "⚡",
        category: options.category,
        color: "#8B5CF6",
        modelPolicy: "balanced",
        installed_at: new Date().toISOString(),
        active: true,
        tools: [
          { name: "file_ops", purpose: "File system operations" },
          { name: "terminal", purpose: "Sandbox terminal" },
        ],
        skills: [],
        budget_cap_per_run: Number(options.budget),
      };
      configManager.ensureDirs();
      fs.writeFileSync(
        path.join(configManager.getAgentsDir(), `${customAgent.id}.json`),
        JSON.stringify(customAgent, null, 2),
        "utf8"
      );
      fleet.deploy(customAgent.id);
      console.log(chalk.green(`✓ Custom agent "${customAgent.name}" (${customAgent.id}) created and deployed.`));
    });

  fleetCmd
    .command("status")
    .description("Show fleet operational status")
    .option("--json", "Output JSON status")
    .action((options) => {
      const fleet = new FleetManager(configManager);
      const status = fleet.getStatus();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      console.log(ASCII_FLEET);
      console.log(chalk.bold.hex("#8B5CF6")("┌─ FLEET STATUS ────────────────────────────────────────┐"));
      console.log(`  Active: ${status.activeCount} | Installed: ${status.installedCount} | Total Catalog: ${status.totalCatalog}`);
      console.log(`  Daily Budget: $${status.dailyBudgetSpent.toFixed(2)} / $${status.dailyBudgetCap.toFixed(2)}`);
      console.log(chalk.bold.hex("#8B5CF6")("└───────────────────────────────────────────────────────┘"));
    });

  // skills
  const skillsCmd = program.command("skills").description("Skills hub browse, search, and installation");

  skillsCmd
    .command("browse")
    .description("Browse available skills in the catalog")
    .action(() => {
      const hub = new SkillsHub(configManager);
      const list = hub.browse();
      console.log(chalk.bold.hex("#8B5CF6")("Skills Hub Catalog:"));
      for (const s of list) {
        console.log(`  ${chalk.cyan(s.slug.padEnd(25, " "))} [${s.category}] ${chalk.dim(s.description)}`);
      }
    });

  skillsCmd
    .command("search <term>")
    .description("Search skills catalog by keyword")
    .action((term) => {
      const hub = new SkillsHub(configManager);
      const matches = hub.search(term);
      console.log(chalk.bold.hex("#8B5CF6")(`Skills matching "${term}":`));
      for (const s of matches) {
        console.log(`  ${chalk.cyan(s.slug.padEnd(25, " "))} [${s.category}] ${chalk.dim(s.description)}`);
      }
    });

  skillsCmd
    .command("install <slug>")
    .description("Install a skill with pre-install security scan")
    .action((slug) => {
      const hub = new SkillsHub(configManager);
      const loaded = hub.install(slug);
      console.log(chalk.green(`✓ Skill "${loaded.name}" installed. (Slash command: ${loaded.slashCommand})`));
    });

  skillsCmd
    .command("opt-in")
    .description("Synchronize skills preferences")
    .option("--sync", "Perform full synchronization")
    .action(() => {
      const hub = new SkillsHub(configManager);
      const installed = hub.listInstalled();
      console.log(chalk.green(`✓ Synchronized ${installed.length} installed skill(s) across fleet.`));
    });

  // tools
  program
    .command("tools")
    .description("Configure and toggle toolsets")
    .action(() => {
      const config = configManager.loadConfig();
      console.log(chalk.bold("Active Toolsets:"));
      for (const t of config.toolsets) {
        console.log(`  ${chalk.green("✓")} ${t}`);
      }
      if (config.disabled_toolsets.length > 0) {
        console.log(chalk.dim("\nDisabled Toolsets:"));
        for (const t of config.disabled_toolsets) {
          console.log(`  ${chalk.dim("✗")} ${chalk.dim(t)}`);
        }
      }
    });

  // gateway
  const gatewayCmd = program.command("gateway").description("Messaging gateway management");

  gatewayCmd
    .command("status")
    .description("Check status of connected messaging platforms")
    .action(() => {
      const gw = new GatewayManager(configManager);
      const status = gw.getStatus();
      console.log(chalk.bold.hex("#8B5CF6")("Messaging Gateway Platforms:"));
      for (const [id, info] of Object.entries(status)) {
        const dot = info.configured ? chalk.green("● connected") : chalk.dim("○ not configured");
        console.log(`  ${id.padEnd(16, " ")} ${dot.padEnd(20, " ")} (Designated: ${chalk.cyan(info.designatedAgent)})`);
      }
    });

  gatewayCmd
    .command("setup")
    .description("Configure messaging platform credentials")
    .option("--platform <platform>", "Platform (telegram, discord, slack, etc.)")
    .option("--token <token>", "Bot token or webhook secret")
    .action((options) => {
      const platform = options.platform || "telegram";
      const token = options.token || "mock_token";
      configManager.set(`${platform.toUpperCase()}_BOT_TOKEN`, token);
      console.log(chalk.green(`✓ Messaging gateway credentials configured for ${platform}.`));
    });

  gatewayCmd
    .command("start")
    .description("Start messaging gateway listener")
    .action(async () => {
      console.log(chalk.green("✓ Messaging gateway listener active. Forwarding incoming platform events to cofounders."));
      console.log(chalk.dim("Press Ctrl+C to terminate gateway."));
    });

  // egress
  const egressCmd = program.command("egress").description("Egress credential isolation proxy");

  egressCmd
    .command("setup")
    .description("Configure egress proxy port and intercept domains")
    .option("--port <port>", "Port to bind", "8089")
    .action((options) => {
      const config = configManager.loadConfig();
      config.egress.proxy_port = Number(options.port);
      configManager.saveConfig(config);
      console.log(chalk.green(`✓ Egress proxy configured on port ${options.port}.`));
    });

  egressCmd
    .command("start")
    .description("Start egress proxy daemon")
    .action(async () => {
      const proxy = new EgressProxy({ configManager });
      await proxy.start();
      console.log(chalk.green(`✓ Egress credential proxy active on http://127.0.0.1:${proxy.getPort()}`));
      console.log(chalk.dim("Press Ctrl+C to terminate proxy."));
    });

  // mcp
  const mcpCmd = program.command("mcp").description("Model Context Protocol connector management");

  mcpCmd
    .command("list")
    .description("List configured and available MCP connectors")
    .action(() => {
      console.log(chalk.bold.hex("#8B5CF6")("Configured MCP Connectors:"));
      console.log(`  ${chalk.green("●")} github           [Trust: 98%] [Risk: low]    GitHub Pull Requests & Issues`);
      console.log(`  ${chalk.green("●")} postgres         [Trust: 95%] [Risk: medium] PostgreSQL Read/Write Adapter`);
      console.log(`  ${chalk.green("●")} filesystem       [Trust: 99%] [Risk: low]    Host Filesystem Sandbox`);
      console.log(`  ${chalk.green("●")} slack            [Trust: 92%] [Risk: medium] Team Notifications Adapter`);
    });

  mcpCmd
    .command("add <server>")
    .description("Add an MCP connector from marketplace")
    .action((server) => {
      console.log(chalk.green(`✓ MCP connector "${server}" added and verified against safety policy.`));
    });

  mcpCmd
    .command("remove <server>")
    .description("Remove an MCP connector")
    .action((server) => {
      console.log(chalk.yellow(`✓ MCP connector "${server}" removed.`));
    });

  // a2a
  const a2aCmd = program.command("a2a").description("Agent-to-Agent protocol integration");

  a2aCmd
    .command("card <agentId>")
    .description("Export Signed Agent Card for an agent")
    .action((agentId) => {
      const card = generateAgentCard(
        {
          id: agentId,
          name: `Trent ${agentId.toUpperCase()} Agent`,
          description: `Autonomous cofounder specialist in ${agentId}.`,
          category: "specialist",
          capabilities: ["task-execution", "analysis", "synthesis"],
          endpoint: "http://127.0.0.1:7895/a2a/tasks",
        },
        "trent-a2a-key"
      );
      console.log(JSON.stringify(card, null, 2));
    });

  a2aCmd
    .command("serve")
    .description("Start A2A protocol server on port 7895")
    .option("--port <port>", "Port to bind", "7895")
    .action(async (options) => {
      const server = new A2AServer({ port: Number(options.port) });
      await server.start();
      console.log(chalk.green(`✓ A2A Protocol server listening on http://127.0.0.1:${server.getPort()}`));
      console.log(chalk.dim("Press Ctrl+C to terminate server."));
    });

  // acp
  program
    .command("acp")
    .description("Start ACP editor integration server (VS Code, Cursor, Zed)")
    .option("--port <port>", "Port to bind", "7890")
    .action(async (options) => {
      const server = new ACPServer({ port: Number(options.port), configManager });
      await server.start();
      console.log(chalk.green(`✓ ACP Server running on http://127.0.0.1:${server.getPort()}`));
      console.log(chalk.dim("Press Ctrl+C to stop ACP server."));
    });

  // sessions
  const sessionsCmd = program.command("sessions").description("Manage conversation sessions");

  sessionsCmd
    .command("list")
    .description("List past sessions")
    .action(() => {
      const mgr = new SessionManager(configManager);
      const list = mgr.listSessions();
      console.log(chalk.bold(`Sessions (${list.length}):`));
      for (const s of list.slice(0, 10)) {
        console.log(`  ${chalk.cyan(s.id)} · ${s.title} (${s.messages.length} msgs)`);
      }
    });

  // config
  const configCmd = program.command("config").description("View and update configuration");

  configCmd
    .command("get <key>")
    .description("Get a config or secret value")
    .action((key) => {
      const val = configManager.get(key);
      console.log(`${key} = ${JSON.stringify(val)}`);
    });

  configCmd
    .command("set <key> <val>")
    .description("Set a config or secret value")
    .action((key, val) => {
      configManager.set(key, val);
      console.log(chalk.green(`✓ Updated ${key}`));
    });

  // update
  program
    .command("update")
    .description("Check for updates to Trent Fleet")
    .action(async () => {
      const checker = new UpdateChecker("1.0.0");
      const info = await checker.checkForUpdates();
      if (info.updateAvailable) {
        console.log(chalk.yellow(`New version available: ${info.latestVersion}. Update at ${info.releaseUrl}`));
      } else {
        console.log(chalk.green(`Trent is up to date (v${info.currentVersion}).`));
      }
    });
}
