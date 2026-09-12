import { ConfigManager } from "../config/ConfigManager.js";
import { QuickSetup } from "./QuickSetup.js";
import { FullSetup } from "./FullSetup.js";
import { BlankSlate } from "./BlankSlate.js";
import type { SetupOptions, SetupResult } from "./types.js";

export class SetupWizard {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public async run(options: SetupOptions): Promise<SetupResult> {
    switch (options.mode) {
      case "quick": {
        const quick = new QuickSetup(this.configManager);
        return await quick.execute(options);
      }
      case "full": {
        const full = new FullSetup(this.configManager);
        return await full.execute(options);
      }
      case "blank-slate": {
        const blank = new BlankSlate(this.configManager);
        return await blank.execute(options);
      }
      default:
        throw new Error(`Unknown setup mode: ${(options as any).mode}`);
    }
  }
}
