import type { Provider, Toolset, TrentConfig, TrentSecrets } from "../config/schema.js";

export type SetupMode = "quick" | "full" | "blank-slate";

export interface SetupOptions {
  mode: SetupMode;
  provider?: Provider;
  model?: string;
  apiKey?: string;
  toolsets?: Toolset[];
  agents?: string[];
  dailyBudget?: number;
  openBrowserForAuth?: boolean;
}

export interface SetupResult {
  mode: SetupMode;
  success: boolean;
  message: string;
  config: TrentConfig;
  secretsConfigured: string[];
}
