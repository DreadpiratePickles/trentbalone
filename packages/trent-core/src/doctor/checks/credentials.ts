import fs from "node:fs";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../probe.js";
import { KEYLESS_PROVIDERS, PROVIDER_CREDENTIALS, credentialForProvider } from "../providers.js";

const CATEGORY = "Credentials";
const NAME = "API Credentials";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/**
 * Read a key from the profile's `.env`, falling back to the process environment. `from` names
 * where it was found, by path or as the environment, for the message; never the value. [P1-D]
 */
function readKey(
  ctx: DoctorContext,
  envVars: readonly string[],
): { envVar: string; value: string; from: string } | undefined {
  let secrets: Record<string, unknown> = {};
  try {
    secrets = ctx.configManager.loadSecrets() as unknown as Record<string, unknown>;
  } catch {
    secrets = {};
  }
  for (const envVar of envVars) {
    const inFile = secrets[envVar];
    const candidate = inFile ?? process.env[envVar];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const from = inFile !== undefined ? ctx.configManager.getSecretsPath() : "the process environment";
      return { envVar, value: candidate.trim(), from };
    }
  }
  return undefined;
}

/** Names only — never values — of the other providers that have a key on this machine. */
function otherConfigured(ctx: DoctorContext, activeProvider: string): string[] {
  return Object.values(PROVIDER_CREDENTIALS)
    .filter((cred) => cred.id !== activeProvider && readKey(ctx, cred.envVars) !== undefined)
    .map((cred) => cred.id);
}

export const checkCredentials: DoctorCheck = {
  id: "check_credentials",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const config = ctx.configManager.loadConfig();
    const provider = config.provider;

    if (KEYLESS_PROVIDERS.has(provider)) {
      return result({
        status: "skip",
        message: `Provider "${provider}" runs locally, no key needed; the Local Model check probes the runtime itself.`,
        details: { provider },
      });
    }

    const credential = credentialForProvider(provider);
    if (!credential) {
      return result({
        status: "fail",
        message: `No credential rules are defined for provider "${provider}".`,
        fixHint: `Set provider to a supported value with \`trent config set provider <name>\`.`,
        details: { provider },
      });
    }

    const secretsPath = ctx.configManager.getSecretsPath();
    const found = readKey(ctx, credential.envVars);
    if (!found) {
      const where = fs.existsSync(secretsPath) ? "is not set in it" : "does not exist yet";
      return result({
        status: "fail",
        message: `Active provider "${provider}" needs ${credential.envVars[0]}; the secrets file ${where}.`,
        fixHint: `Run \`trent config set ${credential.envVars[0]} <your-api-key>\`.`,
        details: { provider, envVar: credential.envVars[0], secretsPath },
      });
    }

    const shape = credential.validateShape(found.value);
    const base = {
      provider,
      envVar: found.envVar,
      keyLength: found.value.length,
      otherProvidersConfigured: otherConfigured(ctx, provider),
    };

    if (!shape.valid) {
      return result({
        status: "fail",
        message: `${found.envVar} (from ${found.from}) is not a usable ${credential.label} key: ${shape.reason}.`,
        fixHint: `Replace it with a real key: \`trent config set ${found.envVar} <your-api-key>\`.`,
        details: { ...base, shape: "invalid" },
      });
    }

    const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const outcome = await credential.probe(found.value, undefined, {
      fetchImpl: ctx.fetchImpl,
      timeoutMs,
    });
    const details = { ...base, shape: "valid", probe: outcome };

    if (outcome === "unauthorized") {
      return result({
        status: "fail",
        message: `${credential.label} rejected ${found.envVar} (from ${found.from}): the key is well formed but not accepted.`,
        fixHint: `Issue a new key in the ${credential.label} console, then \`trent config set ${found.envVar} <your-api-key>\`.`,
        details,
      });
    }

    if (outcome === "unreachable") {
      return result({
        status: "warn",
        message: `${credential.label} was unreachable within ${timeoutMs}ms, so ${found.envVar} (from ${found.from}) could not be verified. Offline is not the same as misconfigured.`,
        fixHint: "Re-run `trent doctor` once network access to the provider is available.",
        details,
      });
    }

    return result({
      status: "ok",
      message: `${found.envVar} (from ${found.from}) authenticated against ${credential.label}.`,
      details,
    });
  },
};
