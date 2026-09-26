import { describe, it, expect } from "vitest";
import { applyCredentials, extractToken, isHostAllowed, OWN_CREDENTIAL_HEADER } from "./CredentialBroker.js";
import type { ProxyTokenRecord } from "./TokenStorePort.js";

const TOKEN = `trnt_egress_${"a".repeat(32)}`;
const SECRET = "sk-real-secret-value";

function record(overrides?: Partial<ProxyTokenRecord>): ProxyTokenRecord {
  return {
    token: TOKEN,
    agentId: "ceo",
    realCredentials: { apiKey: SECRET },
    createdAt: new Date().toISOString(),
    revoked: false,
    ...overrides,
  };
}

describe("isHostAllowed", () => {
  it("denies everything when the allowlist is empty", () => {
    expect(isHostAllowed("api.openai.com", [])).toBe(false);
  });

  it("denies a host that merely contains an allowlisted domain as a substring", () => {
    const allow = ["api.openai.com"];
    expect(isHostAllowed("api.openai.com.evil.test", allow)).toBe(false);
    expect(isHostAllowed("notapi.openai.com", allow)).toBe(false);
    expect(isHostAllowed("api.openai.com", allow)).toBe(true);
  });

  it("honours a leading-label wildcard without matching the bare domain", () => {
    const allow = ["*.openai.com"];
    expect(isHostAllowed("api.openai.com", allow)).toBe(true);
    expect(isHostAllowed("openai.com", allow)).toBe(false);
    expect(isHostAllowed("openai.com.evil.test", allow)).toBe(false);
  });

  it("ignores the port and is case-insensitive", () => {
    expect(isHostAllowed("API.OpenAI.com:443", ["api.openai.com"])).toBe(true);
  });

  it("denies an empty or missing host", () => {
    expect(isHostAllowed("", ["api.openai.com"])).toBe(false);
  });
});

describe("extractToken", () => {
  it("finds the token in the standard headers", () => {
    expect(extractToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extractToken({ "x-api-key": TOKEN })).toBe(TOKEN);
    expect(extractToken({ "x-trent-proxy-token": TOKEN })).toBe(TOKEN);
  });

  it("returns null for anything that is not a broker token", () => {
    expect(extractToken({})).toBeNull();
    expect(extractToken({ authorization: `Bearer ${SECRET}` })).toBeNull();
    expect(extractToken({ authorization: "Basic abc" })).toBeNull();
  });
});

describe("applyCredentials", () => {
  it("strips every client-supplied credential header before injecting the real one", () => {
    const out = applyCredentials(
      { authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN, "proxy-authorization": "x" },
      "api.openai.com",
      record()
    );
    expect(out.authorization).toBe(`Bearer ${SECRET}`);
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("uses the anthropic header convention for anthropic hosts", () => {
    const out = applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.anthropic.com", record());
    expect(out["x-api-key"]).toBe(SECRET);
    expect(out.authorization).toBeUndefined();
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses the google header convention for googleapis hosts", () => {
    const out = applyCredentials({}, "generativelanguage.googleapis.com", record());
    expect(out["x-goog-api-key"]).toBe(SECRET);
  });

  it("honours an explicit header name on the record", () => {
    const out = applyCredentials(
      {},
      "api.openai.com",
      record({ realCredentials: { apiKey: SECRET, headerName: "X-Custom-Key" } })
    );
    expect(out["x-custom-key"]).toBe(SECRET);
  });
});

// [P2-9] own credential
/**
 * A tool that authenticates to its own peer (an A2A agent's bearer) or to nobody marks its request
 * with the own-credential header. The broker then removes only what is its own (the proxy token,
 * the marker, the proxy headers) and adds nothing: the caller's Authorization passes through, and
 * the record's secret, which in the REPL is the model provider key, is never written onto a request
 * bound for somebody else.
 */
describe("applyCredentials with the own-credential marker", () => {
  it("keeps the caller's own Authorization, drops the broker token and the marker, and adds no secret", () => {
    const out = applyCredentials(
      { authorization: "Bearer peer-bearer", "x-trent-proxy-token": TOKEN, [OWN_CREDENTIAL_HEADER]: "1", "proxy-authorization": "x" },
      "agent.example.test",
      record()
    );
    expect(out.authorization).toBe("Bearer peer-bearer");
    expect(out[OWN_CREDENTIAL_HEADER]).toBeUndefined();
    expect(out["x-trent-proxy-token"]).toBeUndefined();
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(out.host).toBe("agent.example.test");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("adds nothing when the caller carries no credential, and still strips a broker token from any credential header", () => {
    const bare = applyCredentials({ "x-trent-proxy-token": TOKEN, [OWN_CREDENTIAL_HEADER]: "1" }, "api.openai.com", record());
    expect(bare.authorization).toBeUndefined();
    expect(JSON.stringify(bare)).not.toContain(SECRET);
    const smuggled = applyCredentials({ authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN, [OWN_CREDENTIAL_HEADER]: "1" }, "agent.example.test", record());
    expect(smuggled.authorization).toBeUndefined();
    expect(smuggled["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(smuggled)).not.toContain(SECRET);
    expect(JSON.stringify(smuggled)).not.toContain(TOKEN);
  });

  it("changes nothing for a request without the marker: the broker still swaps its credential in", () => {
    const out = applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", record());
    expect(out.authorization).toBe(`Bearer ${SECRET}`);
  });
});
