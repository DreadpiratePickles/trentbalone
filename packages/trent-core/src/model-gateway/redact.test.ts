/**
 * T3.2 — prompt-side redaction at the core model gateway.
 *
 * Offline. The provider is a recording fake injected through `streamProvider`, so the assertion is
 * on exactly what would have left the machine. Every credential below is built in the test and
 * never a real one.
 */
import { describe, expect, it } from "vitest";

import { isTrentError } from "../errors/index.js";
import { createModelGateway } from "./index.js";
import { applyPrivacyEnv, createPromptRedactor, privacyFromEnv } from "./redact.js";
import type { GatewayMessage, ProviderStreamFn } from "./types.js";

const FAKE_API_KEY = `sk-${"A1b2C3d4".repeat(5)}`; // sk- + 40 characters, assembled here
const EMAIL = "jane.doe@example.com";
const PHONE = "+14155550123";

function recordingProvider(): { fn: ProviderStreamFn; seen: GatewayMessage[][] } {
  const seen: GatewayMessage[][] = [];
  const fn: ProviderStreamFn = async function* (_provider, _model, input) {
    seen.push(input.messages.map((m) => ({ ...m })));
    yield { type: "token", content: "ok" };
    yield { type: "finish", reason: "stop" };
  };
  return { fn, seen };
}

async function gatewayWith(privacy: { redact_prompts: boolean; patterns?: string[] }, streamProvider: ProviderStreamFn) {
  return createModelGateway({
    apiKeys: { google: "test-google-key" },
    preferredProvider: "google",
    allowedProviders: ["google"],
    models: { executor: "gemini-2.0-flash" },
    streamProvider,
    privacy: { redact_prompts: privacy.redact_prompts, patterns: privacy.patterns ?? [] },
  });
}

describe("createPromptRedactor", () => {
  it("masks an API key, an email and a phone number and reports hit counts only", () => {
    const redactor = createPromptRedactor({ enabled: true, patterns: [] });
    const { text, hits } = redactor.redactText(`key ${FAKE_API_KEY}, mail ${EMAIL}, call ${PHONE}`);
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
    expect(text).toContain("[REDACTED:api-key#1]");
    expect(text).toContain("[REDACTED:email#1]");
    expect(text).toContain("[REDACTED:phone#1]");
    expect(hits).toEqual(
      expect.arrayContaining([
        { kind: "api-key", count: 1 },
        { kind: "email", count: 1 },
        { kind: "phone", count: 1 },
      ]),
    );
    for (const hit of hits) expect(Object.keys(hit)).toEqual(["kind", "count"]);
  });

  it("numbers a repeated value once and a new value next, across the messages of one request", () => {
    const redactor = createPromptRedactor({ enabled: true, patterns: [] });
    const out = redactor.redactMessages([
      { role: "system", content: `owner is ${EMAIL}` },
      { role: "user", content: `write to ${EMAIL} and cc other@example.org` },
    ]);
    expect(out.messages[0]!.content).toBe("owner is [REDACTED:email#1]");
    expect(out.messages[1]!.content).toBe("write to [REDACTED:email#1] and cc [REDACTED:email#2]");
    expect(out.hits).toContainEqual({ kind: "email", count: 3 });
  });

  it("is the identity when disabled", () => {
    const redactor = createPromptRedactor({ enabled: false, patterns: [] });
    const input = `key ${FAKE_API_KEY} mail ${EMAIL}`;
    expect(redactor.redactText(input)).toEqual({ text: input, hits: [] });
  });

  it("masks a user pattern's match", () => {
    const redactor = createPromptRedactor({ enabled: true, patterns: ["ACME-\\d{6}"] });
    const { text, hits } = redactor.redactText("ticket ACME-123456 and ACME-654321");
    expect(text).toBe("ticket [REDACTED:custom#1] and [REDACTED:custom#2]");
    expect(hits).toContainEqual({ kind: "custom", count: 2 });
  });

  it("refuses an invalid user pattern with a TrentError naming the pattern index", () => {
    let caught: unknown;
    try {
      createPromptRedactor({ enabled: true, patterns: ["fine", "(unclosed"] });
    } catch (error) {
      caught = error;
    }
    expect(isTrentError(caught)).toBe(true);
    if (!isTrentError(caught)) return;
    expect(caught.code).toBe(3);
    expect(caught.message).toContain("privacy.patterns[1]");
    expect(caught.context).toMatchObject({ index: 1 });
  });

  it("keeps the telemetry rules' context around a connection string and a named credential", () => {
    const redactor = createPromptRedactor({ enabled: true, patterns: [] });
    const { text, hits } = redactor.redactText(
      'tool result: postgres://app:hunter2secret@db.internal:5432/x and DB_PASSWORD="hunter2secret"',
    );
    expect(text).not.toContain("hunter2secret");
    expect(text).toContain("postgres://app:[REDACTED:connection-string#1]@db.internal:5432/x");
    expect(text).toContain('DB_PASSWORD="[REDACTED:named-credential#1]"');
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(["connection-string", "named-credential"]));
  });

  it("applyPrivacyEnv fills only the variables the operator left unset and returns names, never values", () => {
    const env: NodeJS.ProcessEnv = { TRENT_PRIVACY_PATTERNS: JSON.stringify(["keep-me"]) };
    const written = applyPrivacyEnv({ redact_prompts: true, patterns: ["ACME-\\d{6}"] }, env);
    expect(written).toEqual(["TRENT_PRIVACY_REDACT_PROMPTS"]);
    expect(env.TRENT_PRIVACY_REDACT_PROMPTS).toBe("1");
    expect(env.TRENT_PRIVACY_PATTERNS).toBe(JSON.stringify(["keep-me"]));
    expect(applyPrivacyEnv(undefined, env)).toEqual([]);
  });

  it("reads the env bridge the headless runtime writes from config", () => {
    const saved = { on: process.env.TRENT_PRIVACY_REDACT_PROMPTS, patterns: process.env.TRENT_PRIVACY_PATTERNS };
    try {
      process.env.TRENT_PRIVACY_REDACT_PROMPTS = "1";
      process.env.TRENT_PRIVACY_PATTERNS = JSON.stringify(["ACME-\\d{6}"]);
      expect(privacyFromEnv()).toEqual({ redact_prompts: true, patterns: ["ACME-\\d{6}"] });
      delete process.env.TRENT_PRIVACY_REDACT_PROMPTS;
      delete process.env.TRENT_PRIVACY_PATTERNS;
      expect(privacyFromEnv()).toEqual({ redact_prompts: false, patterns: [] });
    } finally {
      if (saved.on === undefined) delete process.env.TRENT_PRIVACY_REDACT_PROMPTS;
      else process.env.TRENT_PRIVACY_REDACT_PROMPTS = saved.on;
      if (saved.patterns === undefined) delete process.env.TRENT_PRIVACY_PATTERNS;
      else process.env.TRENT_PRIVACY_PATTERNS = saved.patterns;
    }
  });
});

describe("createModelGateway — prompt redaction before the provider call", () => {
  it("masks the key, the email and the phone in every message, numbering the repeated email consistently", async () => {
    const provider = recordingProvider();
    const gateway = await gatewayWith({ redact_prompts: true }, provider.fn);
    await gateway.complete({
      messages: [
        { role: "system", content: `You help ${EMAIL}.` },
        { role: "user", content: `My key is ${FAKE_API_KEY}; phone ${PHONE}; email ${EMAIL} again.` },
      ],
    });
    expect(provider.seen).toHaveLength(1);
    const [system, user] = provider.seen[0]!;
    const joined = `${system!.content}\n${user!.content}`;
    expect(joined).not.toContain(FAKE_API_KEY);
    expect(joined).not.toContain(EMAIL);
    expect(joined).not.toContain(PHONE);
    expect(system!.content).toBe("You help [REDACTED:email#1].");
    expect(user!.content).toBe("My key is [REDACTED:api-key#1]; phone [REDACTED:phone#1]; email [REDACTED:email#1] again.");
  });

  it("passes the messages through verbatim when redaction is disabled", async () => {
    const provider = recordingProvider();
    const gateway = await gatewayWith({ redact_prompts: false }, provider.fn);
    const content = `key ${FAKE_API_KEY} mail ${EMAIL}`;
    await gateway.complete({ messages: [{ role: "user", content }] });
    expect(provider.seen[0]![0]!.content).toBe(content);
  });

  it("masks a user-configured pattern before the provider sees it", async () => {
    const provider = recordingProvider();
    const gateway = await gatewayWith({ redact_prompts: true, patterns: ["ACME-\\d{6}"] }, provider.fn);
    await gateway.complete({ messages: [{ role: "user", content: "close ticket ACME-123456 now" }] });
    expect(provider.seen[0]![0]!.content).toBe("close ticket [REDACTED:custom#1] now");
  });
});
