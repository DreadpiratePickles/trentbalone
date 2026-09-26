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
      record({ hosts: ["api.openai.com"] })
    );
    expect(out.authorization).toBe(`Bearer ${SECRET}`);
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("uses the anthropic header convention for anthropic hosts", () => {
    const out = applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.anthropic.com", record({ hosts: ["api.anthropic.com"] }));
    expect(out["x-api-key"]).toBe(SECRET);
    expect(out.authorization).toBeUndefined();
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses the google header convention for googleapis hosts", () => {
    const out = applyCredentials({}, "generativelanguage.googleapis.com", record({ hosts: ["generativelanguage.googleapis.com"] }));
    expect(out["x-goog-api-key"]).toBe(SECRET);
  });

  it("honours an explicit header name on the record", () => {
    const out = applyCredentials(
      {},
      "api.openai.com",
      record({ hosts: ["api.openai.com"], realCredentials: { apiKey: SECRET, headerName: "X-Custom-Key" } })
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
      record({ hosts: ["agent.example.test"] })
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
    const bare = applyCredentials({ "x-trent-proxy-token": TOKEN, [OWN_CREDENTIAL_HEADER]: "1" }, "api.openai.com", record({ hosts: ["api.openai.com"] }));
    expect(bare.authorization).toBeUndefined();
    expect(JSON.stringify(bare)).not.toContain(SECRET);
    const smuggled = applyCredentials({ authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN, [OWN_CREDENTIAL_HEADER]: "1" }, "agent.example.test", record({ hosts: ["agent.example.test"] }));
    expect(smuggled.authorization).toBeUndefined();
    expect(smuggled["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(smuggled)).not.toContain(SECRET);
    expect(JSON.stringify(smuggled)).not.toContain(TOKEN);
  });

  it("changes nothing for a request without the marker: the broker still swaps its credential in", () => {
    const out = applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", record({ hosts: ["api.openai.com"] }));
    expect(out.authorization).toBe(`Bearer ${SECRET}`);
  });
});

// [egress host binding]
/**
 * A record's secret belongs to the host(s) it was minted for. The broker used to write it onto
 * every allowlisted request carrying the token, so the model provider key reached any other host on
 * `egress.intercept_domains` a sandboxed tool contacted with a plain fetch.
 */
const BUSINESS_HOST = "api.business.example";
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "x-custom-key"];

function expectNoCredential(out: Record<string, unknown>): void {
  for (const name of CREDENTIAL_HEADERS) expect(out[name], name).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain(SECRET);
  expect(JSON.stringify(out)).not.toContain(TOKEN);
}

describe("applyCredentials injects a secret only into the hosts it is bound to", () => {
  it("a token minted for host A adds no credential header to allowlisted host B, while A still receives it", () => {
    const bound = record({ hosts: ["api.openai.com"] });
    const toB = applyCredentials({ authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN, "x-goog-api-key": TOKEN }, BUSINESS_HOST, bound);
    expectNoCredential(toB);
    expect(toB.host).toBe(BUSINESS_HOST);
    const toA = applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", bound);
    expect(toA.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("withholds an explicit header name from an unbound host too", () => {
    const bound = record({ hosts: ["api.openai.com"], realCredentials: { apiKey: SECRET, headerName: "X-Custom-Key" } });
    expectNoCredential(applyCredentials({ "x-trent-proxy-token": TOKEN }, BUSINESS_HOST, bound));
  });

  it("matches on a label boundary: a subdomain of a bound host is bound, a look-alike is not", () => {
    const bound = record({ hosts: ["api.openai.com"] });
    expect(applyCredentials({}, "eu.api.openai.com", bound).authorization).toBe(`Bearer ${SECRET}`);
    expect(applyCredentials({}, "API.OpenAI.com:443", bound).authorization).toBe(`Bearer ${SECRET}`);
    for (const lookAlike of ["evilapi.openai.com", "api.openai.com.evil.test", "openai.com"]) {
      expectNoCredential(applyCredentials({ authorization: `Bearer ${TOKEN}` }, lookAlike, bound));
    }
  });

  it("keeps the anthropic and google header conventions for a bound host", () => {
    const anthropic = applyCredentials({}, "api.anthropic.com", record({ hosts: ["api.anthropic.com"] }));
    expect(anthropic["x-api-key"]).toBe(SECRET);
    expect(anthropic["anthropic-version"]).toBe("2023-06-01");
    const google = applyCredentials({}, "generativelanguage.googleapis.com", record({ hosts: ["generativelanguage.googleapis.com"] }));
    expect(google["x-goog-api-key"]).toBe(SECRET);
    // Bound to Google, the key does not follow the token to Anthropic.
    expectNoCredential(applyCredentials({}, "api.anthropic.com", record({ hosts: ["generativelanguage.googleapis.com"] })));
  });

  it("on a Gemini profile the key does not follow the token to OpenAI or Anthropic, though every provider key variable holds that token", () => {
    // SandboxEnvironment puts the one token in OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY and GOOGLE_API_KEY,
    // and all three provider hosts are on the default allowlist.
    const gemini = record({ hosts: ["generativelanguage.googleapis.com"] });
    expectNoCredential(applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", gemini));
    expectNoCredential(applyCredentials({ "x-api-key": TOKEN, "anthropic-version": "2023-06-01" }, "api.anthropic.com", gemini));
    expect(applyCredentials({ "x-goog-api-key": TOKEN }, "generativelanguage.googleapis.com", gemini)["x-goog-api-key"]).toBe(SECRET);
  });

  it("an unbound host keeps the caller's own credential (a search key) and loses only what carries the broker token", () => {
    const bound = record({ hosts: ["api.openai.com"] });
    const search = applyCredentials({ authorization: "Bearer tvly-fake-caller-key", "x-trent-proxy-token": TOKEN, "proxy-authorization": "x" }, "api.tavily.com", bound);
    expect(search.authorization).toBe("Bearer tvly-fake-caller-key");
    expect(search["x-trent-proxy-token"]).toBeUndefined();
    expect(search["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(search)).not.toContain(SECRET);
    expect(JSON.stringify(search)).not.toContain(TOKEN);
    const mixed = applyCredentials({ authorization: `Bearer ${TOKEN}`, "x-api-key": "caller-own-api-key" }, "r.jina.ai", bound);
    expect(mixed.authorization).toBeUndefined();
    expect(mixed["x-api-key"]).toBe("caller-own-api-key");
    expect(JSON.stringify(mixed)).not.toContain(SECRET);
    // The same holds for a record with no binding at all.
    expect(applyCredentials({ authorization: "Bearer tvly-fake-caller-key", "x-trent-proxy-token": TOKEN }, "api.tavily.com", record()).authorization).toBe("Bearer tvly-fake-caller-key");
  });

  it("a launched browser's token header reaches an unbound host as neither the token nor any credential", () => {
    const out = applyCredentials({ "x-trent-proxy-token": TOKEN, "user-agent": "Mozilla/5.0", accept: "text/html" }, "docs.business.example", record({ hosts: ["api.openai.com"] }));
    expect(out["x-trent-proxy-token"]).toBeUndefined();
    expectNoCredential(out);
    expect(out["user-agent"]).toBe("Mozilla/5.0");
  });

  it("a binding that names a port matches that port only: a local runtime shares 127.0.0.1 with other services", () => {
    const local = record({ hosts: ["127.0.0.1:11434"] });
    expect(applyCredentials({}, "127.0.0.1", local, { port: 11434 }).authorization).toBe(`Bearer ${SECRET}`);
    expectNoCredential(applyCredentials({}, "127.0.0.1", local, { port: 9000 }));
    expectNoCredential(applyCredentials({}, "127.0.0.1", local));
    // An IP literal is never matched as a suffix.
    expectNoCredential(applyCredentials({}, "10.127.0.0.1", record({ hosts: ["127.0.0.1"] }), { port: 11434 }));
  });

  it("reports a withheld secret naming the host and the reason, never the secret or the token", () => {
    const seen: unknown[] = [];
    const onWithheld = (event: unknown): void => void seen.push(event);
    const bound = record({ hosts: ["api.openai.com"] });
    applyCredentials({ authorization: `Bearer ${TOKEN}` }, BUSINESS_HOST, bound, { port: 443, onWithheld });
    expect(seen).toEqual([{ host: BUSINESS_HOST, port: 443, reason: "host_not_bound", boundHosts: ["api.openai.com"] }]);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    // Nothing is reported where nothing is withheld: the bound host, a secretless record, the own-credential marker.
    applyCredentials({}, "api.openai.com", bound, { port: 443, onWithheld });
    applyCredentials({}, BUSINESS_HOST, record({ realCredentials: {} }), { port: 443, onWithheld });
    applyCredentials({ [OWN_CREDENTIAL_HEADER]: "1" }, BUSINESS_HOST, bound, { port: 443, onWithheld });
    expect(seen).toHaveLength(1);
  });
});

describe("a record with no host binding injects nothing (fail closed)", () => {
  it("injects nothing into any host, including the provider host the key was for", () => {
    const legacy = record();
    for (const host of ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", BUSINESS_HOST]) {
      expectNoCredential(applyCredentials({ authorization: `Bearer ${TOKEN}` }, host, legacy));
    }
    expectNoCredential(applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", record({ hosts: [] })));
  });

  it("a hosts value that is not a list of strings (a hand-edited store) injects nothing", () => {
    const corrupted = record({ hosts: "api.openai.com" as unknown as string[] });
    expectNoCredential(applyCredentials({ authorization: `Bearer ${TOKEN}` }, "api.openai.com", corrupted));
  });

  it("reports the missing binding as its own reason", () => {
    const seen: unknown[] = [];
    applyCredentials({}, "api.openai.com", record(), { port: 443, onWithheld: (event) => void seen.push(event) });
    expect(seen).toEqual([{ host: "api.openai.com", port: 443, reason: "no_host_binding", boundHosts: [] }]);
  });
});

describe("the own-credential marker is unchanged by host binding", () => {
  it("on a request to a BOUND host the marker still adds no secret and keeps the caller's own Authorization", () => {
    const out = applyCredentials(
      { authorization: "Bearer peer-bearer", "x-trent-proxy-token": TOKEN, [OWN_CREDENTIAL_HEADER]: "1" },
      "api.openai.com",
      record({ hosts: ["api.openai.com"] })
    );
    expect(out.authorization).toBe("Bearer peer-bearer");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
// [/egress host binding]
