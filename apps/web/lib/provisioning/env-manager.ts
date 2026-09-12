/**
 * lib/provisioning/env-manager.ts
 *
 * Per-company environment variable composition for provisioned execution contexts.
 *
 * Design invariants (Phase 1 inherited):
 *  - Secrets flow only to sandbox process.env — NEVER to logs, model context, or HTTP responses.
 *  - companyId is the sole isolation key. No global caches. No cross-company bleed possible.
 *  - buildProvisioningEnv is a pure read — no writes, no audit entries, no side effects.
 *  - Calling it twice with the same inputs returns identical output (idempotent).
 *
 * Credential boundary:
 *  - Credentials are resolved via resolveCredentialEnv, which decrypts per-company
 *    ToolConnection records using SECRET_ENCRYPTION_KEY. Missing or unresolvable
 *    integrations are silently skipped — never thrown as errors that could leak key names.
 *  - Feature flags are injected under the TRENT_FLAG_* namespace. This namespace
 *    cannot collide with any credential env var name.
 *
 * Usage:
 *  const { env } = await buildProvisioningEnv(companyId, { providers: ["GitHub"] });
 *  await adapter.exec(session, command, { env });   // ← only valid use of the result
 *  // scrub output afterwards with scrubSecrets(output, env) if any secret was injected
 */

import {
  resolveCredentialEnv,
  CREDENTIAL_REGISTRY,
} from "@/lib/credential-boundary";

// ── Public types ──────────────────────────────────────────────────────────────

export type ProvisioningEnvOptions = {
  /**
   * Credential providers to inject (e.g. ["GitHub", "Stripe"]).
   * Each provider is resolved via CREDENTIAL_REGISTRY and store.getIntegration(companyId).
   * Providers with no integration record or corrupt encrypted data are silently skipped.
   */
  providers?: string[];

  /**
   * Company-specific feature flags to inject as TRENT_FLAG_* env vars.
   * { BETA_TERRAFORM: "true" } → TRENT_FLAG_BETA_TERRAFORM=true
   *
   * Values are per-call — never shared across companies.
   * The TRENT_FLAG_* prefix guarantees no collision with credential env var names.
   */
  featureFlags?: Record<string, string>;
};

export type ProvisioningEnvResult = {
  /**
   * The composed env map. Pass to adapter.exec() options.env only.
   * NEVER log, store as a WorkbenchEvent, or include in any model context.
   */
  env: Record<string, string>;

  /**
   * Which providers were successfully resolved (had at least one env var set).
   * Use this to detect when a required credential is missing before running infra commands.
   */
  resolvedProviders: string[];
};

// ── Feature flag prefix ───────────────────────────────────────────────────────

const FLAG_PREFIX = "TRENT_FLAG_";

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Build the env var map for a provisioned execution context.
 *
 * Pure read — no writes to store, no audit entries, no observable side effects.
 * Idempotent: calling twice with the same inputs returns identical output.
 * Scoped to companyId — credentials are NEVER resolved for a different company.
 *
 * @param companyId  The company whose credentials and flags to inject.
 * @param options    Which providers and feature flags to include.
 */
export async function buildProvisioningEnv(
  companyId: string,
  options?: ProvisioningEnvOptions
): Promise<ProvisioningEnvResult> {
  const providers = options?.providers ?? [];
  const featureFlags = options?.featureFlags ?? {};

  // ── 1. Resolve credential env vars from the encrypted store ──────────────
  // resolveCredentialEnv silently skips missing/corrupt entries — never throws.
  const credentialEnv: Record<string, string> =
    providers.length > 0
      ? await resolveCredentialEnv(companyId, providers)
      : {};

  // ── 2. Determine which providers were actually resolved ───────────────────
  // A provider counts as resolved when at least one of its env vars was set.
  const resolvedProviders: string[] = providers.filter((provider) => {
    const spec = CREDENTIAL_REGISTRY[provider];
    if (!spec) return false;
    return spec.envVars.some(({ name }) => name in credentialEnv);
  });

  // ── 3. Map feature flags to the TRENT_FLAG_* namespace ───────────────────
  // Prefixing guarantees no collision with credential env var names.
  const flagEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(featureFlags)) {
    flagEnv[`${FLAG_PREFIX}${key}`] = value;
  }

  // ── 4. Compose final env — credentials first, flags second ───────────────
  // Separate namespaces mean neither can overwrite the other.
  const env: Record<string, string> = {
    ...credentialEnv,
    ...flagEnv,
  };

  return { env, resolvedProviders };
}
