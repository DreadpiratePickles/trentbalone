import dns from "node:dns/promises";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHttp, withDeadline, timedOut } from "../probe.js";
import { doctorEnv, providerEndpoint, type ProviderEndpoint } from "../endpoint.js";

/**
 * [G13] Resolves the configured provider's REAL host. It used to look up api.openai.com whatever
 * the provider, so a Gemini profile was reported on OpenAI's DNS and an offline machine running
 * Ollama was reported degraded. A local runtime is checked at its own URL, with no cloud lookup.
 */

const CATEGORY = "Connectivity";
const NAME = "Network & Cloud Connectivity";
const DNS_TIMEOUT_MS = 3000;

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

async function checkLocal(ctx: DoctorContext, endpoint: ProviderEndpoint): Promise<CheckResult> {
  const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probe = await probeHttp(`${endpoint.url.replace(/\/+$/, "")}/models`, { method: "GET" }, {
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
    timeoutMs,
  });
  const details = { provider: endpoint.provider, url: endpoint.url, local: true };
  if (probe.kind === "response") {
    return result({
      status: "ok",
      message: `Local runtime at ${endpoint.url} answered (HTTP ${probe.response.status}); provider "${endpoint.provider}" runs locally, so no cloud host was resolved.`,
      details: { ...details, httpStatus: probe.response.status },
    });
  }
  const why = probe.kind === "timeout" ? `no answer within ${timeoutMs}ms` : "no connection";
  return result({
    status: "warn",
    message: `Nothing answered at ${endpoint.url} (${why}), where provider "${endpoint.provider}" sends every model call; no cloud host was resolved.`,
    fixHint: `Start the local runtime${endpoint.baseUrlEnv ? `, or point ${endpoint.baseUrlEnv} at the one that runs it` : ""}; the Local Model check has the detail.`,
    details: { ...details, probe: probe.kind },
  });
}

async function checkHosted(ctx: DoctorContext, endpoint: ProviderEndpoint): Promise<CheckResult> {
  const lookup = ctx.lookupHost ?? ((host: string) => dns.lookup(host));
  let failure: string | undefined;
  const outcome = await withDeadline(async () => {
    try {
      await lookup(endpoint.host);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }, DNS_TIMEOUT_MS);
  if (timedOut(outcome)) failure = `no DNS answer within ${DNS_TIMEOUT_MS}ms`;
  const details = { provider: endpoint.provider, host: endpoint.host, local: false };
  if (failure !== undefined) {
    return result({
      status: "warn",
      message: `Could not resolve ${endpoint.host}, the API host of provider "${endpoint.provider}": ${failure}. Offline or a DNS problem.`,
      fixHint: "Check your local internet connection or proxy settings.",
      details,
    });
  }
  return result({
    status: "ok",
    message: `Resolved ${endpoint.host}, the API host of provider "${endpoint.provider}".`,
    details,
  });
}

export const checkConnectivity: DoctorCheck = {
  id: "check_connectivity",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const provider = ctx.configManager.loadConfig().provider;
    const endpoint = providerEndpoint(provider, doctorEnv(ctx));
    if (endpoint === undefined) {
      return result({
        status: "warn",
        message: `Provider "${provider}" has no known API host, so connectivity was not checked.`,
        fixHint: "Set provider to a supported value with `trent config set provider <name>`.",
        details: { provider },
      });
    }
    return endpoint.local ? checkLocal(ctx, endpoint) : checkHosted(ctx, endpoint);
  },
};
