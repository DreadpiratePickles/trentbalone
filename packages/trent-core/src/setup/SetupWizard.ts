import os from "node:os";
import { ConfigManager } from "../config/index.js";
import { TrentError, EXIT } from "../errors/TrentError.js";
import { BlankSlate } from "./BlankSlate.js";
import { FullSetup } from "./FullSetup.js";
import { QuickSetup } from "./QuickSetup.js";
import { InquirerPrompts } from "./InquirerPrompts.js";
import { NoTerminalPrompts, noTerminalForMode } from "./no-terminal.js";
import { ConsoleOutput } from "./ports.js";
import { createLocalRuntime } from "./local-runtime.js";
import { writeDefaultHeartbeatChecklist } from "../heartbeat/checklist.js";
import type { SetupContext, SetupOptions, SetupResult } from "./types.js";

/**
 * Entry point for the three setup modes.
 *
 * Everything external — config manager, prompts, output, environment — is injected, so the same code
 * path serves a real terminal and a test with a scripted answer stream. Nothing here reads a TTY
 * directly and nothing imports `@inquirer/prompts` except the adapter that wraps it.
 */
export class SetupWizard {
  private readonly ctx: SetupContext;

  constructor(context: Partial<SetupContext> = {}) {
    const prompts = context.prompts ?? new InquirerPrompts();
    this.ctx = {
      configManager: context.configManager ?? new ConfigManager(),
      prompts,
      // The terminal adapter needs a terminal; a scripted or injected port answers for itself.
      interactive: context.interactive ?? (prompts instanceof InquirerPrompts ? process.stdin.isTTY === true : true),
      output: context.output ?? new ConsoleOutput(),
      env: context.env ?? process.env,
      ...(context.runDoctor ? { runDoctor: context.runDoctor } : {}),
      ...(context.mediaBackendPresent ? { mediaBackendPresent: context.mediaBackendPresent } : {}),
      ...(context.socialProviderConnected ? { socialProviderConnected: context.socialProviderConnected } : {}),
      ...(context.businessProviderConnected ? { businessProviderConnected: context.businessProviderConnected } : {}),
      localRuntime: context.localRuntime ?? createLocalRuntime(),
      totalMemoryBytes: context.totalMemoryBytes ?? os.totalmem(),
    };
  }

  async run(options: SetupOptions): Promise<SetupResult> {
    // Without a terminal: full and blank-slate refuse before touching the profile; quick runs, and
    // needs none when there is no key (it asks nothing), refusing only at its one confirmation.
    const interactive = this.ctx.interactive !== false;
    if (!interactive && (options.mode === "full" || options.mode === "blank-slate")) {
      throw noTerminalForMode(options.mode);
    }
    const ctx: SetupContext = interactive ? this.ctx : { ...this.ctx, prompts: new NoTerminalPrompts(options.mode) };

    ctx.configManager.ensureDirs();
    // The heartbeat checklist is the founder's file: written once, never rewritten by setup.
    writeDefaultHeartbeatChecklist(ctx.configManager.getProfileDir());

    switch (options.mode) {
      case "quick":
        return await new QuickSetup(ctx).execute(options);
      case "full":
        return await new FullSetup(ctx).execute(options);
      case "blank-slate":
        return await new BlankSlate(ctx).execute(options);
      default:
        throw new TrentError({
          code: EXIT.USAGE,
          operation: "setup.run",
          message: `unknown setup mode: ${String((options as { mode?: unknown }).mode)}`,
        });
    }
  }
}
