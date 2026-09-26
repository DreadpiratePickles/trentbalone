/**
 * The host(s) a model provider's key belongs to, for binding the broker token that stands in for it.
 *
 * Where a provider's model calls go is already decided in one place, `doctor/endpoint.ts`
 * `providerEndpoint` (the mirror of the runtime's clients: `OPENAI_BASE_URL`, `GOOGLE_BASE_URL`,
 * `MISTRAL_BASE_URL`, `OPENROUTER_BASE_URL`, the fixed Anthropic host, and the alias table in
 * `model-gateway/providers.ts` for ollama, lmstudio, deepseek and groq). This only turns that URL
 * into a binding: the host, plus the port when the URL names one (a local runtime on 127.0.0.1
 * shares that address with every other local service). No provider, an unknown one or an
 * unparseable base URL binds nothing, so the broker injects the key nowhere.
 */
import { providerEndpoint } from "../doctor/endpoint.js";
import { normalizeCredentialHosts } from "./host-binding.js";

export function credentialHostsForProvider(provider: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (provider === undefined || provider.trim() === "") return [];
  const endpoint = providerEndpoint(provider.trim().toLowerCase(), env);
  if (endpoint === undefined) return [];
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return [];
  }
  if (url.hostname === "") return [];
  try {
    return normalizeCredentialHosts([url.port === "" ? url.hostname : `${url.hostname}:${url.port}`]);
  } catch {
    return [];
  }
}
