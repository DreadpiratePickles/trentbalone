import type { ToolCallRecord } from "@/lib/types";
import type { ToolAdapter } from "@/lib/tools";

export type ProviderReadinessStatus = "real" | "unavailable" | "approval_required" | "test_only" | "failed";

export type ProviderReadiness = {
  key: string;
  label: string;
  status: ProviderReadinessStatus;
  recovery?: string;
};

export function providerReadinessSnapshot(env: NodeJS.ProcessEnv = process.env): ProviderReadiness[] {
  return [
    readiness("github", "GitHub", Boolean(env.GITHUB_TOKEN), "Connect a GitHub App/token with repo read/write permissions."),
    readiness("browser", "Browser automation", Boolean(env.STEEL_API_KEY || env.BROWSERBASE_API_KEY || env.CAMOFOX_BASE_URL || env.PLAYWRIGHT_BROWSERS_PATH), "Install Playwright browsers or configure a cloud browser provider."),
    readiness("mcp", "MCP", Boolean(env.DATABASE_URL), "Configure DATABASE_URL, then connect MCP server URL/token in the MCP page."),
    sandboxReadiness(env),
    readiness("database", "Database", Boolean(env.DATABASE_URL), "Configure DATABASE_URL."),
    readiness("deploy", "Deploy", Boolean(env.VERCEL_TOKEN || env.RAILWAY_TOKEN || env.RENDER_API_KEY), "Configure Vercel, Railway, or Render credentials."),
    readiness("email", "Email", Boolean(env.POSTMARK_TOKEN || env.RESEND_API_KEY), "Configure Postmark or Resend credentials."),
    readiness("social", "Social", Boolean(env.LATE_API_KEY || env.META_ACCESS_TOKEN), "Configure social publishing credentials."),
    readiness("billing", "Billing", Boolean(env.STRIPE_SECRET_KEY), "Configure Stripe credentials."),
    readiness("analytics", "Analytics", Boolean(env.POSTHOG_API_KEY || env.GA_PROPERTY_ID), "Configure analytics provider credentials."),
  ];
}

export function toolUnavailableResult(adapter: ToolAdapter, action: string): ToolCallRecord | undefined {
  if (adapter.availability === "unavailable") {
    return {
      adapter: adapter.name,
      action,
      status: "failed",
      summary: `${adapter.name} is not configured. Connect the real provider before agents can use this tool.`,
    };
  }
  if (adapter.availability === "test_only" && process.env.NODE_ENV === "production") {
    return {
      adapter: adapter.name,
      action,
      status: "failed",
      summary: `${adapter.name} is not configured for production. Test-only/mock adapters cannot produce real tool success.`,
    };
  }
  return undefined;
}

function sandboxReadiness(env: NodeJS.ProcessEnv): ProviderReadiness {
  if (env.E2B_API_KEY || env.DAYTONA_API_KEY) {
    return { key: "sandbox", label: "Workbench sandbox", status: "real" };
  }
  if (env.NODE_ENV === "production") {
    return {
      key: "sandbox",
      label: "Workbench sandbox",
      status: "unavailable",
      recovery: "Configure E2B_API_KEY or DAYTONA_API_KEY; production cannot use mock_local.",
    };
  }
  return {
    key: "sandbox",
    label: "Workbench sandbox",
    status: "test_only",
    recovery: "Local mock_local sandbox is for development/testing only.",
  };
}

function readiness(key: string, label: string, configured: boolean, recovery: string): ProviderReadiness {
  return configured ? { key, label, status: "real" } : { key, label, status: "unavailable", recovery };
}
