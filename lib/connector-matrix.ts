import { providerReadinessSnapshot, type ProviderReadinessStatus } from "@/lib/provider-readiness";

export type ConnectorMatrixStatus = "connected" | "needs_credentials" | "failed" | "approval_required";
export type ConnectorProofStatus = "passed" | "failed" | "partial" | "not_recorded";

export type ConnectorProofHint = {
  status: ConnectorProofStatus;
  detail?: string;
};

export type ConnectorMatrixRow = {
  key: string;
  label: string;
  category: "code" | "revenue" | "customer" | "infra" | "agent_tools";
  status: ConnectorMatrixStatus;
  approvalPolicy: string;
  proofStatus: ConnectorProofStatus;
  proofDetail: string;
  nextAction: string;
};

export type ConnectorMatrix = {
  generatedAt: string;
  rows: ConnectorMatrixRow[];
  summary: {
    connected: number;
    needsCredentials: number;
    failed: number;
    approvalRequired: number;
  };
};

type Options = {
  env?: NodeJS.ProcessEnv;
  proofStatuses?: Map<string, ConnectorProofHint>;
  mcpServerCount?: number;
};

const REQUIRED = [
  { key: "github", label: "GitHub", category: "code", env: ["GITHUB_TOKEN", "GITHUBTOKEN"], approvalPolicy: "approval required for writes", nextAction: "Connect a repo-scoped GitHub token and run the private import proof." },
  { key: "stripe", label: "Stripe", category: "revenue", env: ["STRIPE_SECRET_KEY"], readinessKey: "billing", approvalPolicy: "approval required for charges/refunds", nextAction: "Connect a Stripe restricted test key and rerun provider proof." },
  { key: "posthog", label: "PostHog", category: "customer", env: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_API_KEY"], approvalPolicy: "read-only analytics allowed", nextAction: "Add PostHog personal API key plus project id." },
  { key: "sentry", label: "Sentry", category: "infra", env: ["SENTRY_AUTH_TOKEN", "SENTRY_API_TOKEN"], approvalPolicy: "read-only error reads allowed", nextAction: "Add Sentry token and project/org settings." },
  { key: "resend", label: "Resend", category: "customer", env: ["RESEND_API_KEY", "RESEND_AUTH_TOKEN"], readinessKey: "email", approvalPolicy: "approval required for outbound sends", nextAction: "Configure Resend token and verified sender/domain." },
  { key: "attio", label: "Attio CRM", category: "customer", env: ["ATTIO_TOKEN"], approvalPolicy: "approval required for CRM writes", nextAction: "Add Attio token and workspace URL." },
  { key: "mcp", label: "MCP tools", category: "agent_tools", env: ["DATABASE_URL"], approvalPolicy: "approval required by default", nextAction: "Connect at least one MCP server from the MCP page." },
  { key: "database", label: "Database", category: "infra", env: ["DATABASE_URL"], approvalPolicy: "schema/data writes require app policy", nextAction: "Configure DATABASE_URL." },
  { key: "deploy", label: "Deploy provider", category: "infra", env: ["RAILWAY_TOKEN", "VERCEL_TOKEN", "RENDER_API_KEY"], approvalPolicy: "approval required for deploys", nextAction: "Configure Railway, Vercel, or Render token." },
  { key: "sandbox", label: "Workbench sandbox", category: "infra", env: ["DAYTONA_API_KEY", "E2B_API_KEY"], approvalPolicy: "safe sandbox commands allowed; external writes gated", nextAction: "Configure Daytona or E2B and rerun Workbench live proof." },
  { key: "browser", label: "Browser verification", category: "infra", env: ["PLAYWRIGHT_BROWSERS_PATH", "BROWSERBASE_API_KEY", "STEEL_API_KEY", "CAMOFOX_BASE_URL"], approvalPolicy: "browser reads/screenshots allowed", nextAction: "Install Playwright browsers or configure a cloud browser provider." },
] as const;

export function buildConnectorMatrix(options: Options = {}): ConnectorMatrix {
  const env = options.env ?? process.env;
  const readiness = providerReadinessSnapshot(env);
  const rows = REQUIRED.map((definition): ConnectorMatrixRow => {
    const proof = options.proofStatuses?.get(definition.key);
    const status = statusFor(definition, env, readiness, proof, options.mcpServerCount ?? 0);
    return {
      key: definition.key,
      label: definition.label,
      category: definition.category,
      status,
      approvalPolicy: definition.approvalPolicy,
      proofStatus: proof?.status ?? "not_recorded",
      proofDetail: proof?.detail ?? "No live proof artifact recorded for this connector yet.",
      nextAction: status === "connected" ? "Keep proof current after deploys or credential changes." : definition.nextAction,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      connected: rows.filter((row) => row.status === "connected").length,
      needsCredentials: rows.filter((row) => row.status === "needs_credentials").length,
      failed: rows.filter((row) => row.status === "failed").length,
      approvalRequired: rows.filter((row) => row.status === "approval_required").length,
    },
  };
}

function statusFor(
  definition: typeof REQUIRED[number],
  env: NodeJS.ProcessEnv,
  readiness: ReturnType<typeof providerReadinessSnapshot>,
  proof: ConnectorProofHint | undefined,
  mcpServerCount: number,
): ConnectorMatrixStatus {
  if (proof?.status === "failed") return "failed";
  const readinessKey = "readinessKey" in definition ? definition.readinessKey : definition.key;
  const readinessStatus = readiness.find((row) => row.key === readinessKey)?.status;
  if (readinessStatus === "failed") return "failed";
  if (definition.key === "mcp") {
    if (!env.DATABASE_URL) return "needs_credentials";
    return mcpServerCount > 0 ? "connected" : "approval_required";
  }
  if (readinessStatus) return mapProviderStatus(readinessStatus);
  return definition.env.some((key) => Boolean(env[key])) ? "connected" : "needs_credentials";
}

function mapProviderStatus(status: ProviderReadinessStatus): ConnectorMatrixStatus {
  if (status === "real") return "connected";
  if (status === "failed") return "failed";
  if (status === "approval_required") return "approval_required";
  return "needs_credentials";
}
