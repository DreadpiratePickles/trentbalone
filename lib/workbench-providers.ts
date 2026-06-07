/**
 * Workbench Provider Registry — load all providers safely.
 *
 * - mock_local always registers.
 * - e2b and daytona are imported synchronously because their SDKs are declared
 *   dependencies and production session startup must not race async imports.
 *
 * To switch the default for new sessions:
 *   export WORKBENCH_DEFAULT_PROVIDER=e2b      # or daytona / mock_local
 */

import "@/lib/workbench-local-provider";
import "@/lib/workbench-e2b-provider";
import "@/lib/workbench-daytona-provider";

export const registeredWorkbenchProviderModules = ["mock_local", "e2b", "daytona"] as const;

/**
 * Resolve the default provider for a new session. The user can pin it via
 * WORKBENCH_DEFAULT_PROVIDER; otherwise we prefer real sandboxes when their
 * keys are present, then fall back to mock_local.
 */
export function getDefaultWorkbenchProvider(): "mock_local" | "e2b" | "daytona" {
  const explicit = process.env.WORKBENCH_DEFAULT_PROVIDER?.trim().toLowerCase();
  if (explicit === "e2b" || explicit === "daytona" || explicit === "mock_local") {
    if (explicit === "mock_local" && process.env.NODE_ENV === "production") {
      throw new Error("mock_local Workbench provider is dev/test only. Configure WORKBENCH_DEFAULT_PROVIDER=daytona or e2b in production.");
    }
    return explicit;
  }
  if (process.env.E2B_API_KEY) return "e2b";
  if (process.env.DAYTONA_API_KEY) return "daytona";
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No production Workbench sandbox provider configured. Set WORKBENCH_DEFAULT_PROVIDER, DAYTONA_API_KEY, or E2B_API_KEY."
    );
  }
  return "mock_local";
}
