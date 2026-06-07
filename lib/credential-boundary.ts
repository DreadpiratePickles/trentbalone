import { store } from "@/lib/store";
import { decryptJson } from "@/lib/secrets";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchExecOptions,
  WorkbenchExecResult,
  WorkbenchProviderAdapter
} from "@/lib/workbench-provider";

// ── Credential Registry ──────────────────────────────────────────────────────

type CredentialSpec = {
  envVars: Array<{ name: string; field: string }>;
};

export const CREDENTIAL_REGISTRY: Record<string, CredentialSpec> = {
  GitHub:    { envVars: [{ name: "GITHUB_TOKEN",       field: "token" }] },
  GitLab:    { envVars: [{ name: "GITLAB_TOKEN",       field: "token" }] },
  Bitbucket: { envVars: [{ name: "BITBUCKET_TOKEN",    field: "token" }] },
  Stripe:    { envVars: [{ name: "STRIPE_SECRET_KEY",  field: "secretKey" }] },
  Postmark:  { envVars: [{ name: "POSTMARK_API_KEY",   field: "apiKey" }] },
  OpenAI:    { envVars: [{ name: "OPENAI_API_KEY",     field: "apiKey" }] },
  Anthropic: { envVars: [{ name: "ANTHROPIC_API_KEY",  field: "apiKey" }] },
  Meta:      { envVars: [{ name: "META_ACCESS_TOKEN",  field: "accessToken" }] },
  Google:    { envVars: [{ name: "GOOGLE_API_KEY",     field: "apiKey" }] },
  E2B:       { envVars: [{ name: "E2B_API_KEY",        field: "apiKey" }] },
  Daytona:   { envVars: [
    { name: "DAYTONA_API_KEY", field: "apiKey" },
    { name: "DAYTONA_API_URL", field: "apiUrl" },
    { name: "DAYTONA_TARGET", field: "target" },
  ] },
};

const SCRUB_MIN_LENGTH = 8;
const PROVIDER_LOOKUP_ALIASES: Record<string, string[]> = {
  Meta: ["Ads:Meta"],
};

// ── scrubSecrets ─────────────────────────────────────────────────────────────

export function scrubSecrets(
  text: string,
  secrets: Record<string, string>
): string {
  let result = text;
  for (const value of Object.values(secrets)) {
    if (value.length >= SCRUB_MIN_LENGTH) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  return result;
}

// ── resolveCredentialEnv ──────────────────────────────────────────────────────

export async function resolveCredentialEnv(
  companyId: string,
  providers: string[]
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const provider of providers) {
    const spec = CREDENTIAL_REGISTRY[provider];
    if (!spec) continue;

    const integration = await findIntegrationForProvider(companyId, provider);
    if (!integration?.encryptedData) continue;

    let data: Record<string, unknown>;
    try {
      data = decryptJson<Record<string, unknown>>(integration.encryptedData);
    } catch {
      console.error(`[CredentialBoundary] Failed to decrypt ${provider} credentials for company ${companyId}`);
      continue;
    }

    for (const { name, field } of spec.envVars) {
      const value = data[field];
      if (typeof value === "string" && value.length > 0) {
        env[name] = value;
      }
    }
  }

  return env;
}

async function findIntegrationForProvider(companyId: string, provider: string) {
  for (const lookupProvider of [provider, ...(PROVIDER_LOOKUP_ALIASES[provider] ?? [])]) {
    const integration = await store.getIntegration(companyId, lookupProvider);
    if (integration) return integration;
  }
  return undefined;
}

export async function resolveWorkbenchProviderCredentialEnv(
  companyId: string,
  provider: "e2b" | "daytona",
): Promise<{ source: "company" | "environment" | "missing"; env: Record<string, string> }> {
  const credentialProvider = provider === "e2b" ? "E2B" : "Daytona";
  const spec = CREDENTIAL_REGISTRY[credentialProvider];
  const companyEnv = await resolveCredentialEnv(companyId, [credentialProvider]);
  const requiredKey = spec.envVars[0]?.name;
  if (requiredKey && companyEnv[requiredKey]) {
    return { source: "company", env: companyEnv };
  }

  const environmentEnv = Object.fromEntries(
    spec.envVars
      .map(({ name }) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  if (requiredKey && environmentEnv[requiredKey]) {
    return { source: "environment", env: environmentEnv };
  }

  return { source: "missing", env: {} };
}

// ── execWithCredentials ───────────────────────────────────────────────────────

export async function execWithCredentials(
  adapter: WorkbenchProviderAdapter,
  session: WorkbenchSession,
  command: string,
  options?: WorkbenchExecOptions & { providers?: string[] }
): Promise<WorkbenchExecResult> {
  const { providers, ...execOptions } = options ?? {};

  const credentialEnv = providers?.length
    ? await resolveCredentialEnv(session.companyId, providers)
    : {};

  const mergedEnv: Record<string, string> = {
    ...credentialEnv,
    ...(execOptions.env ?? {})
  };

  const result = await adapter.exec(session, command, {
    ...execOptions,
    env: mergedEnv
  });

  // Scrub only resolved credentials — not caller-supplied env vars, which are
  // the caller's responsibility and may contain non-secret values.
  return {
    ...result,
    stdout: scrubSecrets(result.stdout, credentialEnv),
    stderr: scrubSecrets(result.stderr, credentialEnv)
  };
}
