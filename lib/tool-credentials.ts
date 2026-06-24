import { store } from "@/lib/store";
import { decryptJson } from "@/lib/secrets";
import { logger } from "@/lib/logger";

export type CredentialSource = "company" | "env" | "none";

export type ResolvedCredential<T> = {
  /** The resolved secret, or undefined when nothing is configured. */
  value: T | undefined;
  /** "company" = per-tenant ToolConnection, "env" = global fallback, "none" = unconfigured. */
  source: CredentialSource;
};

type IntegrationLike = { encryptedData?: string | null } | undefined;

export type ResolveToolCredentialDeps = {
  getIntegration?: (companyId: string, provider: string) => Promise<IntegrationLike>;
  decrypt?: (ciphertext: string) => unknown;
};

/**
 * Resolve a tool credential for a company. A per-company **encrypted
 * ToolConnection** takes precedence; a global **env** credential is the
 * fallback. This is the platform seam that lets agents act under each
 * customer's OWN account (their Slack workspace, their Vercel project)
 * instead of one shared account — the prerequisite for multi-tenant sale.
 *
 * Generalizes the lib/github.ts getGitHubCredentials pattern
 * (store.getIntegration + decryptJson, env fallback) to any provider.
 * `deps` is injectable so adapters can be unit-tested without a DB or a
 * real SECRET_ENCRYPTION_KEY.
 */
export async function resolveToolCredential<T extends Record<string, unknown>>(opts: {
  companyId?: string;
  provider: string;
  envFallback?: () => T | undefined;
  deps?: ResolveToolCredentialDeps;
}): Promise<ResolvedCredential<T>> {
  const getIntegration = opts.deps?.getIntegration ?? ((companyId, provider) => store.getIntegration(companyId, provider));
  const decrypt = opts.deps?.decrypt ?? decryptJson;

  if (opts.companyId) {
    try {
      const connection = await getIntegration(opts.companyId, opts.provider);
      if (connection?.encryptedData) {
        const value = decrypt(connection.encryptedData);
        if (value && typeof value === "object") return { value: value as T, source: "company" };
      }
    } catch (err) {
      // A bad/rotated key must not crash the agent — fall back to env, but make
      // the failure visible to ops rather than silently using the wrong account.
      logger.warn(
        { provider: opts.provider, companyId: opts.companyId, err: (err as Error).message },
        "tool_credential.resolve_failed",
      );
    }
  }

  const fallback = opts.envFallback?.();
  return fallback ? { value: fallback, source: "env" } : { value: undefined, source: "none" };
}
