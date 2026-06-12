import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type LiveProviderProofStatus = "passed" | "failed" | "skipped";

export type LiveProviderProof = {
  key: string;
  label: string;
  status: LiveProviderProofStatus;
  configured: boolean;
  httpStatus?: number;
  evidence?: Record<string, unknown>;
  recovery?: string;
  error?: string;
};

export type LiveProviderProofReport = {
  generatedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    weakestStatus: LiveProviderProofStatus;
  };
  proofs: LiveProviderProof[];
};

export type RunLiveProviderProofsOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  providers?: string[];
};

type ProofContext = {
  env: EnvLike;
  fetchImpl: FetchLike;
  redact: (value: unknown) => unknown;
};

type ProofDefinition = {
  key: string;
  label: string;
  requiredEnv: string[];
  recovery: string;
  isConfigured?(env: EnvLike): boolean;
  run(context: ProofContext): Promise<Omit<LiveProviderProof, "key" | "label" | "configured">>;
};

const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";

export async function runLiveProviderProofs(options: RunLiveProviderProofsOptions = {}): Promise<LiveProviderProofReport> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const selected = options.providers ? new Set(options.providers.map((key) => key.trim().toLowerCase())) : undefined;
  const definitions = liveProviderProofDefinitions().filter((definition) => !selected || selected.has(definition.key));
  const redact = createRedactor(env);
  const proofs: LiveProviderProof[] = [];

  for (const definition of definitions) {
    const configured = definition.isConfigured
      ? definition.isConfigured(env)
      : definition.requiredEnv.every((key) => Boolean(firstNonEmpty(env[key])));
    if (!configured) {
      proofs.push({
        key: definition.key,
        label: definition.label,
        status: "skipped",
        configured: false,
        recovery: definition.recovery,
      });
      continue;
    }

    try {
      const result = await definition.run({ env, fetchImpl, redact });
      proofs.push({
        key: definition.key,
        label: definition.label,
        configured: true,
        ...result,
        error: typeof result.error === "string" ? String(redact(result.error)) : undefined,
        evidence: result.evidence ? redact(result.evidence) as Record<string, unknown> : undefined,
        recovery: result.status === "failed" ? result.recovery ?? definition.recovery : result.recovery,
      });
    } catch (error) {
      proofs.push({
        key: definition.key,
        label: definition.label,
        status: "failed",
        configured: true,
        error: String(redact(error instanceof Error ? error.message : String(error))),
        recovery: definition.recovery,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeProofs(proofs),
    proofs,
  };
}

export function liveProviderProofDefinitions(): ProofDefinition[] {
  return [
    {
      key: "attio",
      label: "Attio CRM",
      requiredEnv: ["ATTIO_TOKEN"],
      recovery: "Configure ATTIO_TOKEN with read access to the Attio workspace.",
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.ATTIO_TOKEN), "Attio token");
        if ("error" in token) return token.error;
        const response = await fetchJson(fetchImpl, "https://api.attio.com/v2/objects", {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/json",
          },
        });
        if (!response.ok) return failed(response, "Attio rejected the credential or workspace access.");
        const objects = arrayBody(response.body, "data");
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            objectCount: objects.length,
            workspaceConfigured: Boolean(firstNonEmpty(env.ATTIO_WORKSPACE_URL)),
          },
        };
      },
    },
    {
      key: "resend",
      label: "Resend email",
      requiredEnv: ["RESEND_API_KEY"],
      recovery: "Configure RESEND_API_KEY and a verified RESEND_FROM_DOMAIN or RESEND_FROM_EMAIL.",
      isConfigured: (env) => Boolean(firstNonEmpty(env.RESEND_API_KEY, env.RESEND_AUTH_TOKEN)),
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.RESEND_API_KEY, env.RESEND_AUTH_TOKEN), "Resend API key");
        if ("error" in token) return token.error;
        const response = await fetchJson(fetchImpl, "https://api.resend.com/domains", {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/json",
          },
        });
        if (!response.ok) return failed(response, "Resend domain lookup failed.");
        const domains = arrayBody(response.body, "data");
        const configuredDomain = firstNonEmpty(
          env.RESEND_FROM_DOMAIN,
          env.RESEND_INBOUND_DOMAIN,
          env.TRENT_EMAIL_DOMAIN,
          env.TRENT_PLATFORM_DOMAIN,
          env.BASE_DOMAIN,
        );
        const matchedDomain = configuredDomain
          ? domains.find((domain) => asRecord(domain)?.name === configuredDomain)
          : undefined;
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            domainCount: domains.length,
            configuredDomain,
            configuredDomainStatus: typeof asRecord(matchedDomain)?.status === "string"
              ? asRecord(matchedDomain)?.status
              : undefined,
            outboundSenderConfigured: Boolean(firstNonEmpty(env.RESEND_FROM_EMAIL, env.TRENT_EMAIL_FROM, env.EMAIL_FROM) || configuredDomain),
            inboundWebhookSecretConfigured: Boolean(firstNonEmpty(env.RESEND_WEBHOOK_SECRET)),
          },
        };
      },
    },
    {
      key: "stripe",
      label: "Stripe billing",
      requiredEnv: ["STRIPE_SECRET_KEY"],
      recovery: "Configure a Stripe test or live secret key with read permissions.",
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.STRIPE_SECRET_KEY), "Stripe secret key");
        if ("error" in token) return token.error;
        const response = await fetchJson(fetchImpl, "https://api.stripe.com/v1/balance", {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/json",
          },
        });
        if (!response.ok) return failed(response, "Stripe balance read failed.");
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            availableBalances: balanceCount(response.body, "available"),
            pendingBalances: balanceCount(response.body, "pending"),
          },
        };
      },
    },
    {
      key: "posthog",
      label: "PostHog analytics",
      requiredEnv: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"],
      recovery: "Configure POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID/POSTHOG_TEAM_ID.",
      isConfigured: (env) => Boolean(
        firstNonEmpty(env.POSTHOG_PERSONAL_API_KEY, env.POSTHOG_API_KEY)
        && firstNonEmpty(env.POSTHOG_PROJECT_ID, env.POSTHOG_TEAM_ID),
      ),
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.POSTHOG_PERSONAL_API_KEY, env.POSTHOG_API_KEY), "PostHog API key");
        if ("error" in token) return token.error;
        const projectId = firstNonEmpty(env.POSTHOG_PROJECT_ID, env.POSTHOG_TEAM_ID);
        const host = firstNonEmpty(env.POSTHOG_HOST, env.POSTHOG_BASE_URL)?.replace(/\/+$/, "") || DEFAULT_POSTHOG_HOST;
        const response = await fetchJson(fetchImpl, `${host}/api/projects/${encodeURIComponent(projectId ?? "")}/query/`, {
          method: "POST",
          headers: {
            Authorization: token.header,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query: {
              kind: "HogQLQuery",
              query: "select event, count() from events where timestamp > now() - interval 1 day group by event limit 5",
            },
            name: "trent_live_provider_proof",
          }),
        });
        if (!response.ok) return failed(response, "PostHog HogQL read failed.");
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            resultRows: arrayBody(response.body, "results").length,
            host,
          },
        };
      },
    },
    {
      key: "sentry",
      label: "Sentry errors",
      requiredEnv: ["SENTRY_AUTH_TOKEN"],
      recovery: "Configure SENTRY_AUTH_TOKEN and, if needed, SENTRY_ORG.",
      isConfigured: (env) => Boolean(firstNonEmpty(env.SENTRY_AUTH_TOKEN, env.SENTRY_API_TOKEN)),
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.SENTRY_AUTH_TOKEN, env.SENTRY_API_TOKEN), "Sentry token");
        if ("error" in token) return token.error;
        const org = firstNonEmpty(env.SENTRY_ORG, env.SENTRY_ORGANIZATION, env.SENTRY_ORG_SLUG);
        const url = org
          ? `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/?query=is%3Aunresolved&limit=1`
          : "https://sentry.io/api/0/organizations/";
        const response = await fetchJson(fetchImpl, url, {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/json",
          },
        });
        if (!response.ok) return failed(response, "Sentry read failed.");
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            checked: org ? "issues" : "organizations",
            itemCount: Array.isArray(response.body) ? response.body.length : 0,
            orgConfigured: Boolean(org),
          },
        };
      },
    },
    {
      key: "x",
      label: "X social",
      requiredEnv: ["X_USER_ACCESS_TOKEN"],
      recovery: "Configure X_USER_ACCESS_TOKEN with OAuth2 user-context permissions.",
      isConfigured: (env) => Boolean(firstNonEmpty(env.X_USER_ACCESS_TOKEN, env.TWITTER_USER_ACCESS_TOKEN)),
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.X_USER_ACCESS_TOKEN, env.TWITTER_USER_ACCESS_TOKEN), "X user access token");
        if ("error" in token) return token.error;
        const response = await fetchJson(fetchImpl, "https://api.x.com/2/users/me", {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/json",
          },
        });
        if (!response.ok) return failed(response, "X user-context credential check failed.");
        const data = asRecord(asRecord(response.body)?.data);
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            username: typeof data?.username === "string" ? data.username : undefined,
            userIdPresent: typeof data?.id === "string",
          },
        };
      },
    },
    {
      key: "github",
      label: "GitHub repo",
      requiredEnv: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"],
      recovery: "Configure GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO for the target proof repo.",
      isConfigured: (env) => Boolean(firstNonEmpty(env.GITHUB_TOKEN, env.GITHUBTOKEN) && firstNonEmpty(env.GITHUB_OWNER) && firstNonEmpty(env.GITHUB_REPO)),
      async run({ env, fetchImpl }) {
        const token = bearerToken(firstNonEmpty(env.GITHUB_TOKEN, env.GITHUBTOKEN), "GitHub token");
        if ("error" in token) return token.error;
        const owner = firstNonEmpty(env.GITHUB_OWNER);
        const repo = firstNonEmpty(env.GITHUB_REPO);
        const response = await fetchJson(fetchImpl, `https://api.github.com/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`, {
          method: "GET",
          headers: {
            Authorization: token.header,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!response.ok) return failed(response, "GitHub repository lookup failed.");
        const body = asRecord(response.body);
        return {
          status: "passed",
          httpStatus: response.status,
          evidence: {
            fullName: typeof body?.full_name === "string" ? body.full_name : `${owner}/${repo}`,
            private: typeof body?.private === "boolean" ? body.private : undefined,
          },
        };
      },
    },
  ];
}

function summarizeProofs(proofs: LiveProviderProof[]): LiveProviderProofReport["summary"] {
  const failedCount = proofs.filter((proof) => proof.status === "failed").length;
  const skippedCount = proofs.filter((proof) => proof.status === "skipped").length;
  return {
    total: proofs.length,
    passed: proofs.filter((proof) => proof.status === "passed").length,
    failed: failedCount,
    skipped: skippedCount,
    weakestStatus: failedCount > 0 ? "failed" : skippedCount > 0 ? "skipped" : "passed",
  };
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit) {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => undefined);
  return { ok: response.ok, status: response.status, body };
}

function failed(
  response: { status: number; body: unknown },
  fallback: string,
): Omit<LiveProviderProof, "key" | "label" | "configured"> {
  return {
    status: "failed",
    httpStatus: response.status,
    error: providerErrorMessage(response.body) || `HTTP ${response.status}`,
    recovery: fallback,
  };
}

function bearerToken(token: string | undefined, label: string): { header: string } | { error: Omit<LiveProviderProof, "key" | "label" | "configured"> } {
  if (!token || !isHttpHeaderValueSafe(token)) {
    return {
      error: {
        status: "failed",
        error: malformedCredentialSummary(label),
        recovery: `Re-paste ${label} as plain ASCII without rich-text or hidden characters.`,
      },
    };
  }
  return { header: `Bearer ${token}` };
}

function createRedactor(env: EnvLike) {
  const secrets = Object.entries(env)
    .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD|AUTH|WEBHOOK|CLIENT_SECRET/i.test(key))
    .map(([, value]) => value?.trim())
    .filter((value): value is string => Boolean(value && value.length >= 8));

  function redactString(input: string) {
    return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), input);
  }

  function redact(value: unknown): unknown {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    }
    return value;
  }

  return redact;
}

function providerErrorMessage(body: unknown) {
  const record = asRecord(body);
  if (!record) return undefined;
  if (typeof record.message === "string") return record.message;
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.error === "string") return record.error;
  const nestedError = asRecord(record.error);
  if (typeof nestedError?.message === "string") return nestedError.message;
  const errors = Array.isArray(record.errors) ? record.errors : undefined;
  const firstError = errors?.map(asRecord).find(Boolean);
  if (typeof firstError?.message === "string") return firstError.message;
  return undefined;
}

function arrayBody(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function balanceCount(body: unknown, key: string) {
  return arrayBody(body, key).filter((item) => typeof asRecord(item)?.amount === "number").length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}
