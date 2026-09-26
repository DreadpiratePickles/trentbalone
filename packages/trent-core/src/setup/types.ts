import type { ConfigManager } from "../config/index.js";
import type { Provider, Toolset, TrentConfig } from "../config/schema.js";
import type { OutputPort, PromptPort } from "./ports.js";
import type { LocalRuntimePort } from "./local-runtime.js";

export type SetupMode = "quick" | "full" | "blank-slate";

/**
 * Why a run did not complete. `no-key`: quick setup found no provider key, so there was nothing to
 * configure (the first launch still opens the REPL, degraded). `cancelled`: the user declined the
 * confirmation. [L0-3] `runtime-unreachable`: a local provider's runtime (Ollama, LM Studio) did not
 * answer. `model-not-pulled`: it answered without the model, and nothing was pulled. A caller
 * branches on this, never on the wording of `message`.
 */
export type SetupIncompleteReason = "no-key" | "cancelled" | "runtime-unreachable" | "model-not-pulled";

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
  /** [L0-3] Quick, Ollama only: pull a model that is not there yet, after a confirmation. */
  pull?: boolean;
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
  /**
   * [B2] Quick setup turns the `media` toolset on only when a backend exists: ffmpeg and ffprobe on
   * the PATH of `env`, or the media image. Injected so a test decides; defaults to the real probe.
   */
  mediaBackendPresent?: () => Promise<boolean>;
  /**
   * [B1] Quick setup turns the `social` toolset on only when at least one social provider is
   * connected through `trent connect` (meta, bluesky or buffer). Injected so a test decides;
   * defaults to reading the profile's connect state by name.
   */
  socialProviderConnected?: () => boolean;
  /**
   * [B3] Quick setup turns the `business` toolset on only when at least one of its providers
   * (stripe, google, square, twilio) is connected through `trent connect`. Injected so a test
   * decides; defaults to reading the profile's connect state by name.
   */
  businessProviderConnected?: () => boolean;
  /**
   * Whether anything can answer a prompt. Defaults to `process.stdin.isTTY` for the terminal adapter
   * and to true for any other injected port. When false, full and blank-slate refuse before they
   * touch the profile, and a quick run that reaches its confirmation refuses there, each with one
   * readable line and exit 2, instead of an inquirer error from a closed stdin.
   */
  interactive?: boolean;
  /**
   * [L0-3] The local runtime (Ollama, LM Studio): is it up, what has it pulled, pull one more.
   * Injected so a test answers with a fake `fetch`; defaults to the real endpoints.
   */
  localRuntime?: LocalRuntimePort;
  /** [L0-3] The machine's memory, which picks the recommended local model. Defaults to `os.totalmem()`. */
  totalMemoryBytes?: number;
}

export interface SetupResult {
  mode: SetupMode;
  success: boolean;
  message: string;
  /** Set only when `success` is false. */
  reason?: SetupIncompleteReason;
  /** `null` when the run deliberately wrote nothing. */
  config: TrentConfig | null;
  /** Names of secrets written to the profile `.env`. Never their values. */
  secretsConfigured: string[];
  /** Every line shown to the user during the run. */
  output: string[];
}
