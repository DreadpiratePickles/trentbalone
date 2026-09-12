/**
 * The environment handed to a sandboxed process.
 *
 * This is the single place a child environment is built, so there is one place to audit for the
 * property that matters: the real key is never a value here. Credential env vars keep their normal
 * names (`OPENAI_API_KEY`, ...) so unmodified SDKs work unchanged - they just hold an opaque token
 * that only means something at the egress boundary.
 */

export const CONTAINER_CA_PATH = "/usr/local/share/ca-certificates/trent-egress-ca.crt";

export interface SandboxEnvInput {
  /** The opaque broker token. Never a real secret. */
  token: string;
  /** Proxy the sandbox must route through, e.g. http://127.0.0.1:8089. */
  proxyUrl: string;
  /** Path, inside the sandbox, of the mounted egress CA certificate. */
  caCertPath: string;
  /** Env var names that normally hold a provider key. Each receives the token instead. */
  credentialEnvNames?: string[];
  /** Extra non-secret environment to pass through. */
  base?: Record<string, string>;
  /** Hosts the sandbox may reach without the proxy. */
  noProxy?: string;
}

export const DEFAULT_CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/** Build the child environment. Callers must not merge `process.env` into the result. */
export function buildSandboxEnv(input: SandboxEnvInput): Record<string, string> {
  const names = input.credentialEnvNames ?? DEFAULT_CREDENTIAL_ENV_NAMES;
  const env: Record<string, string> = { ...(input.base ?? {}) };

  for (const name of names) env[name] = input.token;

  env.TRENT_PROXY_TOKEN = input.token;
  env.HTTP_PROXY = input.proxyUrl;
  env.HTTPS_PROXY = input.proxyUrl;
  env.http_proxy = input.proxyUrl;
  env.https_proxy = input.proxyUrl;
  env.NO_PROXY = input.noProxy ?? "localhost,127.0.0.1";
  env.no_proxy = env.NO_PROXY;

  // Every common runtime's trust-store hook, so the interception CA is trusted without a rebuild.
  env.NODE_EXTRA_CA_CERTS = input.caCertPath;
  env.REQUESTS_CA_BUNDLE = input.caCertPath;
  env.SSL_CERT_FILE = input.caCertPath;
  env.CURL_CA_BUNDLE = input.caCertPath;
  env.GIT_SSL_CAINFO = input.caCertPath;

  return env;
}

/** Docker `-e KEY=VALUE` argv pairs. Each value stays one argv element; no shell is involved. */
export function toDockerEnvArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }
  return args;
}
