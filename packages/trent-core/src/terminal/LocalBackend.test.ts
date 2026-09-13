/**
 * `LocalBackend` used to spread the whole `process.env` into every child. A seat running
 * `env` on the local backend would have printed every provider key the CLI had loaded from the
 * profile's .env. Hermes scrubs the child environment by secret substring (`code_execution_env.py`);
 * so does this backend now.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "./LocalBackend.js";
import { scrubChildEnv } from "./env-scrub.js";

const PROBE = "trent-local-backend-probe-value";
const KEYS = ["TRENT_TEST_OPENAI_API_KEY", "TRENT_TEST_TOKEN", "TRENT_TEST_DATABASE_DSN", "TRENT_TEST_PLAIN"] as const;

describe("LocalBackend child environment", () => {
  beforeEach(() => {
    for (const key of KEYS) process.env[key] = `${PROBE}-${key}`;
  });
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it("never forwards a variable whose name carries a secret substring", async () => {
    const res = await new LocalBackend().execute("env");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain(`${PROBE}-TRENT_TEST_OPENAI_API_KEY`);
    expect(res.stdout).not.toContain(`${PROBE}-TRENT_TEST_TOKEN`);
    expect(res.stdout).not.toContain(`${PROBE}-TRENT_TEST_DATABASE_DSN`);
    // Plain names that match no safe prefix are dropped too: allowlist, not denylist.
    expect(res.stdout).not.toContain(`${PROBE}-TRENT_TEST_PLAIN`);
    expect(res.stdout).toMatch(/^PATH=/m);
  });

  it("still passes caller-supplied env and the proxy token", async () => {
    const res = await new LocalBackend().execute("env", { env: { TRENT_EXTRA: "yes" }, proxyToken: "trnt_x" });
    expect(res.stdout).toMatch(/^TRENT_EXTRA=yes$/m);
    expect(res.stdout).toMatch(/^TRENT_PROXY_TOKEN=trnt_x$/m);
  });
});

describe("scrubChildEnv", () => {
  it("keeps safe prefixes, blocks secret substrings, drops everything else", () => {
    const out = scrubChildEnv({
      PATH: "/bin",
      HOME: "/home/x",
      LANG: "C",
      MY_SECRET_THING: "s",
      GITHUB_TOKEN: "t",
      BYPASS_CACHE: "1",
      SOMETHING_ELSE: "x",
      TRENT_PROFILE: "default",
    });
    expect(out).toEqual({ PATH: "/bin", HOME: "/home/x", LANG: "C", TRENT_PROFILE: "default" });
  });
});
