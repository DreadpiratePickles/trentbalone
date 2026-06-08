/**
 * Workbench Provider Registry — load all providers safely.
 *
 * - mock_local always registers.
 * - e2b and daytona are imported synchronously because their SDKs are declared
 *   dependencies and production session startup must not race async imports.
 * - railway delegates to mock_local and is production-approved for Railway
 *   deployments where the container itself is the isolation boundary.
 *
 * To switch the default for new sessions:
 *   export WORKBENCH_DEFAULT_PROVIDER=railway   # Railway-hosted production
 *   export WORKBENCH_DEFAULT_PROVIDER=e2b       # E2B cloud sandboxes
 *   export WORKBENCH_DEFAULT_PROVIDER=daytona   # Daytona cloud workspaces
 */

import "@/lib/workbench-local-provider";
import "@/lib/workbench-e2b-provider";
import "@/lib/workbench-daytona-provider";
import "@/lib/workbench-railway-provider";

export const registeredWorkbenchProviderModules = ["mock_local", "e2b", "daytona", "railway"] as const;

/**
 * Resolve the default provider for a new session. The user can pin it via
 * WORKBENCH_DEFAULT_PROVIDER; otherwise we prefer real sandboxes when their
 * keys are present, then fall back to mock_local.
 */
export function getDefaultWorkbenchProvider(): "mock_local" | "e2b" | "daytona" | "railway" {
  const explicit = process.env.WORKBENCH_DEFAULT_PROVIDER?.trim().toLowerCase();
  if (explicit === "railway") return "railway";
  if (explicit === "e2b" || explicit === "daytona" || explicit === "mock_local") {
    if (explicit === "mock_local" && process.env.NODE_ENV === "production") {
      throw new Error("mock_local Workbench provider is dev/test only. Configure WORKBENCH_DEFAULT_PROVIDER=railway, daytona, or e2b in production.");
    }
    return explicit;
  }
  if (process.env.E2B_API_KEY) return "e2b";
  if (process.env.DAYTONA_API_KEY) return "daytona";
  // Auto-detect Railway: RAILWAY_ENVIRONMENT is injected by Railway into every service.
  if (process.env.RAILWAY_ENVIRONMENT) return "railway";
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No production Workbench sandbox provider configured. Set WORKBENCH_DEFAULT_PROVIDER=railway (or daytona/e2b), or ensure RAILWAY_ENVIRONMENT is set."
    );
  }
  return "mock_local";
}
