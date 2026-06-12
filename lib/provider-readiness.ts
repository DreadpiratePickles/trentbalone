import type { ToolCallRecord } from "@/lib/types";
import type { ToolAdapter } from "@/lib/tools";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

export type ProviderReadinessStatus = "real" | "unavailable" | "approval_required" | "test_only" | "failed";

export type ProviderReadiness = {
  key: string;
  label: string;
  status: ProviderReadinessStatus;
  recovery?: string;
};

export function providerReadinessSnapshot(env: NodeJS.ProcessEnv = process.env): ProviderReadiness[] {
  return [
    githubReadiness(env),
    readiness("browser", "Browser automation", Boolean(env.STEEL_API_KEY || env.BROWSERBASE_API_KEY || env.CAMOFOX_BASE_URL || env.PLAYWRIGHT_BROWSERS_PATH), "Install Playwright browsers or configure a cloud browser provider."),
    readiness("mcp", "MCP", Boolean(env.DATABASE_URL), "Configure DATABASE_URL, then connect MCP server URL/token in the MCP page."),
    sandboxReadiness(env),
    readiness("database", "Database", Boolean(env.DATABASE_URL), "Configure DATABASE_URL."),
    readiness("deploy", "Deploy", Boolean(env.VERCEL_TOKEN || env.RAILWAY_TOKEN || env.RENDER_API_KEY), "Configure Vercel, Railway, or Render credentials."),
    readiness("email", "Email", emailConfigured(env), "Configure Postmark or Resend credentials plus a verified sender/from domain."),
    readiness("social", "Social", Boolean(env.X_USER_ACCESS_TOKEN || env.TWITTER_USER_ACCESS_TOKEN || env.LATE_API_KEY || env.META_ACCESS_TOKEN), "Configure social publishing credentials."),
    billingReadiness(env),
    readiness("analytics", "Analytics", Boolean(((env.POSTHOG_PERSONAL_API_KEY || env.POSTHOG_API_KEY) && (env.POSTHOG_PROJECT_ID || env.POSTHOG_TEAM_ID)) || env.GA_PROPERTY_ID), "Configure analytics provider credentials."),
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

function githubReadiness(env: NodeJS.ProcessEnv): ProviderReadiness {
  const token = env.GITHUB_TOKEN || env.GITHUBTOKEN;
  if (!token) {
    return {
      key: "github",
      label: "GitHub",
      status: "unavailable",
      recovery: "Connect a GitHub App/token with repo read/write permissions.",
    };
  }
  if (!isHttpHeaderValueSafe(token)) {
    return {
      key: "github",
      label: "GitHub",
      status: "failed",
      recovery: malformedCredentialSummary("GitHub token"),
    };
  }
  return { key: "github", label: "GitHub", status: "real" };
}

function billingReadiness(env: NodeJS.ProcessEnv): ProviderReadiness {
  if (!env.STRIPE_SECRET_KEY) {
    return {
      key: "billing",
      label: "Billing",
      status: "unavailable",
      recovery: "Configure Stripe credentials.",
    };
  }
  if (!isHttpHeaderValueSafe(env.STRIPE_SECRET_KEY)) {
    return {
      key: "billing",
      label: "Billing",
      status: "failed",
      recovery: malformedCredentialSummary("Stripe secret key"),
    };
  }
  return { key: "billing", label: "Billing", status: "real" };
}

function readiness(key: string, label: string, configured: boolean, recovery: string): ProviderReadiness {
  return configured ? { key, label, status: "real" } : { key, label, status: "unavailable", recovery };
}

function emailConfigured(env: NodeJS.ProcessEnv) {
  const postmarkToken = Boolean(env.POSTMARK_API_KEY || env.POSTMARK_TOKEN || env.POSTMARK_SERVER_TOKEN);
  const postmarkSender = Boolean(env.POSTMARK_FROM_EMAIL || env.EMAIL_FROM);
  const resendToken = Boolean(env.RESEND_API_KEY || env.RESEND_AUTH_TOKEN);
  const resendSender = Boolean(
    env.RESEND_FROM_EMAIL
    || env.TRENT_EMAIL_FROM
    || env.EMAIL_FROM
    || env.RESEND_FROM_DOMAIN
    || env.TRENT_EMAIL_DOMAIN
    || env.TRENT_PLATFORM_DOMAIN
    || env.BASE_DOMAIN,
  );
  return (postmarkToken && postmarkSender) || (resendToken && resendSender);
}
