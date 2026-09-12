import type { ConfigManager } from "../config/index.js";
import type { Provider, Toolset, TrentConfig } from "../config/schema.js";
import type { OutputPort, PromptPort } from "./ports.js";

export type SetupMode = "quick" | "full" | "blank-slate";

/**
 * Non-interactive overrides. Anything left undefined is prompted for (Full and Blank Slate) or
 * detected (Quick).
 *
 * `dailyBudgetCents` and `perRunCapCents` are named for their unit on purpose: the field they replace
 * was called `dailyBudget` and silently carried dollars into a cents-shaped config.
 */
export interface SetupOptions {
  mode: SetupMode;
  provider?: Provider;
  model?: string;
  /** Written to the profile `.env`, never to `config.yaml`, never echoed. */
  apiKey?: string;
  toolsets?: Toolset[];
  agents?: string[];
  dailyBudgetCents?: number;
  perRunCapCents?: number;
}

export interface DoctorSummary {
  ok: boolean;
  summary: string;
}

/**
 * Everything the wizard touches from outside itself. Injecting all four is what makes the wizard
 * drivable by a test with no TTY and no real home directory.
 */
export interface SetupContext {
  configManager: ConfigManager;
  prompts: PromptPort;
  output: OutputPort;
  env: NodeJS.ProcessEnv;
  /**
   * Optional post-setup health check. Injected rather than imported so `setup/` does not depend on
   * `doctor/`; the CLI wires the real one in.
   */
  runDoctor?: () => Promise<DoctorSummary>;
}

export interface SetupResult {
  mode: SetupMode;
  success: boolean;
  message: string;
  /** `null` when the run deliberately wrote nothing. */
  config: TrentConfig | null;
  /** Names of secrets written to the profile `.env`. Never their values. */
  secretsConfigured: string[];
  /** Every line shown to the user during the run. */
  output: string[];
}
