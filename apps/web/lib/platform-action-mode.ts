export type PlatformActionExecutionMode = "live" | "sandbox";

export function isPlatformActionLiveMode(): boolean {
  return process.env.PLATFORM_ACTION_MODE === "live";
}

export function platformActionExecutionMode(): PlatformActionExecutionMode {
  return isPlatformActionLiveMode() ? "live" : "sandbox";
}

export function isSandboxExternalRef(ref: string | undefined | null): boolean {
  return typeof ref === "string" && ref.startsWith("sandbox_");
}

export function resolvePlatformActionExecutionMode(input: {
  executionMode?: unknown;
  externalRef?: string | null;
}): PlatformActionExecutionMode {
  if (input.executionMode === "live" || input.executionMode === "sandbox") {
    return input.executionMode;
  }
  if (isSandboxExternalRef(input.externalRef)) return "sandbox";
  return platformActionExecutionMode();
}

export function platformActionModeLabel(mode: PlatformActionExecutionMode): string {
  return mode === "sandbox" ? "Simulated (sandbox)" : "Live";
}

export function labelSimulatedAction(summary: string, mode: PlatformActionExecutionMode): string {
  return mode === "sandbox" ? `[Simulated] ${summary}` : summary;
}
