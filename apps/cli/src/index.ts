#!/usr/bin/env node
import { Command } from "commander";
import { ConfigManager } from "@trent/core";
import { registerCommands } from "./commands/index.js";
import { ClassicRepl } from "./repl/index.js";

async function main() {
  const program = new Command();
  program
    .name("trent")
    .description("Trent Fleet — Autonomous AI Cofounder Platform")
    .version("1.0.0")
    .option("-c, --continue", "Resume the last conversation session")
    .option("--tui", "Launch the modern interactive Terminal UI (Ink)")
    .option("-p, --profile <profile>", "Use custom configuration profile", "default");

  registerCommands(program);

  // If arguments passed, parse with commander
  const rawArgs = process.argv.slice(2);
  const isNoArgsOrOnlyFlags =
    rawArgs.length === 0 ||
    rawArgs.every((arg) => arg.startsWith("-"));

  if (!isNoArgsOrOnlyFlags) {
    await program.parseAsync(process.argv);
    return;
  }

  // Parse top-level flags
  program.parse(process.argv);
  const opts = program.opts();

  const configManager = new ConfigManager({ profile: opts.profile });

  // First-run automatic setup check
  if (!configManager.exists()) {
    console.log("No configuration found. Initializing quick setup...\n");
    const { SetupWizard } = await import("@trent/core");
    const wizard = new SetupWizard(configManager);
    await wizard.run({ mode: "quick" });
  }

  // If --tui option specified, launch TUI
  if (opts.tui) {
    const { runTui } = await import("./tui/index.js");
    await runTui({ profile: opts.profile });
    return;
  }

  // Default: Launch Classic REPL
  const repl = new ClassicRepl({
    continueSession: opts.continue,
    profile: opts.profile,
  });

  await repl.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
