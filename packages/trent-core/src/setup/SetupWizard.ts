import { ConfigManager } from "../config/index.js";
import { TrentError, EXIT } from "../errors/TrentError.js";
import { BlankSlate } from "./BlankSlate.js";
import { FullSetup } from "./FullSetup.js";
import { QuickSetup } from "./QuickSetup.js";
import { InquirerPrompts } from "./InquirerPrompts.js";
import { ConsoleOutput } from "./ports.js";
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
    this.ctx = {
      configManager: context.configManager ?? new ConfigManager(),
      prompts: context.prompts ?? new InquirerPrompts(),
      output: context.output ?? new ConsoleOutput(),
      env: context.env ?? process.env,
      ...(context.runDoctor ? { runDoctor: context.runDoctor } : {}),
    };
  }

  async run(options: SetupOptions): Promise<SetupResult> {
    this.ctx.configManager.ensureDirs();
    // The heartbeat checklist is the founder's file: written once, never rewritten by setup.
    writeDefaultHeartbeatChecklist(this.ctx.configManager.getProfileDir());

    switch (options.mode) {
      case "quick":
        return await new QuickSetup(this.ctx).execute(options);
      case "full":
        return await new FullSetup(this.ctx).execute(options);
      case "blank-slate":
        return await new BlankSlate(this.ctx).execute(options);
      default:
        throw new TrentError({
          code: EXIT.USAGE,
          operation: "setup.run",
          message: `unknown setup mode: ${String((options as { mode?: unknown }).mode)}`,
        });
    }
  }
}
