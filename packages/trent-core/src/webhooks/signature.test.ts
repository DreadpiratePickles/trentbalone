/**
 * [H3] Signature verification per scheme, over the raw body, compared in constant time.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubSigned, hmacHex, route, SECRET, stripeSigned, timestampSigned } from "./fakes.test-helpers.js"; // [C8] timestampSigned
import { isLoopbackAddress, verifyWebhookSignature } from "./signature.js";

const NOW = new Date("2026-09-26T09:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

describe("github: X-Hub-Signature-256", () => {
  const gh = route();

  it("passes the signature GitHub computes over the raw body", () => {
    const signed = githubSigned({ a: 1 });
    expect(verifyWebhookSignature({ route: gh, body: signed.body, headers: signed.headers, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it("refuses another secret, a missing header, a bare hex and a non-hex value", () => {
    const signed = githubSigned({ a: 1 });
    const bad = (headers: Record<string, string>) => verifyWebhookSignature({ route: gh, body: signed.body, headers, secret: SECRET, now: NOW }).ok;
    expect(bad(githubSigned({ a: 1 }, "other-secret").headers)).toBe(false);
    expect(bad({})).toBe(false);
    expect(bad({ "x-hub-signature-256": hmacHex(SECRET, signed.body) })).toBe(false);
    expect(bad({ "x-hub-signature-256": "sha256=zz" })).toBe(false);
  });

  it("refuses a body changed after signing", () => {
    const signed = githubSigned({ amount: 100 });
    const tampered = Buffer.from(JSON.stringify({ amount: 900 }));
    expect(verifyWebhookSignature({ route: gh, body: tampered, headers: signed.headers, secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("compares with crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    const signed = githubSigned({ a: 1 });
    verifyWebhookSignature({ route: gh, body: signed.body, headers: signed.headers, secret: SECRET, now: NOW });
    expect(spy).toHaveBeenCalled();
  });
});

describe("stripe: Stripe-Signature t/v1", () => {
  const stripe = route({ signature: "stripe", tolerance_seconds: 300 });

  it("passes a v1 over `${t}.${body}` inside the tolerance", () => {
    const signed = stripeSigned({ id: "evt_1" }, NOW);
    expect(verifyWebhookSignature({ route: stripe, body: signed.body, headers: signed.headers, secret: SECRET, now: new Date(NOW.getTime() + 299_000) })).toEqual({ ok: true });
  });

  it("passes when any one of several v1 values matches (secret rotation)", () => {
    const signed = stripeSigned({ id: "evt_1" }, NOW);
    const header = signed.headers["stripe-signature"]!.replace(",v1=", `,v1=${"0".repeat(64)},v1=`);
    expect(verifyWebhookSignature({ route: stripe, body: signed.body, headers: { "stripe-signature": header }, secret: SECRET, now: NOW }).ok).toBe(true);
  });

  it("refuses a timestamp outside the tolerance either way, a v0-only header and a missing t", () => {
    const signed = stripeSigned({ id: "evt_1" }, NOW);
    const check = (headers: Record<string, string>, now = NOW) => verifyWebhookSignature({ route: stripe, body: signed.body, headers, secret: SECRET, now }).ok;
    expect(check(signed.headers, new Date(NOW.getTime() + 301_000))).toBe(false);
    expect(check(signed.headers, new Date(NOW.getTime() - 301_000))).toBe(false);
    expect(check({ "stripe-signature": signed.headers["stripe-signature"]!.replace("v1=", "v0=") })).toBe(false);
    expect(check({ "stripe-signature": signed.headers["stripe-signature"]!.replace(/^t=\d+,/, "") })).toBe(false);
  });
});

describe("hmac-sha256: generic HMAC over the raw body with a configurable header", () => {
  it("reads the configured header, with or without the sha256= prefix", () => {
    const generic = route({ signature: "hmac-sha256", signature_header: "X-Acme-Signature" });
    const body = Buffer.from('{"x":1}');
    const hex = hmacHex(SECRET, body);
    const ok = (headers: Record<string, string>) => verifyWebhookSignature({ route: generic, body, headers, secret: SECRET, now: NOW }).ok;
    expect(ok({ "x-acme-signature": hex })).toBe(true);
    expect(ok({ "x-acme-signature": `sha256=${hex.toUpperCase()}` })).toBe(true);
    expect(ok({ "x-webhook-signature": hex })).toBe(false);
  });

  it("defaults the header to x-webhook-signature", () => {
    const generic = route({ signature: "hmac-sha256" });
    const body = Buffer.from('{"x":1}');
    expect(verifyWebhookSignature({ route: generic, body, headers: { "x-webhook-signature": hmacHex(SECRET, body) }, secret: SECRET, now: NOW }).ok).toBe(true);
  });

  it("refuses an empty secret whatever the header says", () => {
    const generic = route({ signature: "hmac-sha256" });
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature({ route: generic, body, headers: { "x-webhook-signature": hmacHex("", body) }, secret: "", now: NOW }).ok).toBe(false);
  });
});

// [C8] The generic scheme bound to a timestamp, so a captured delivery cannot be replayed once the
// dedupe window has passed. Each `it` builds its route, so the file still collects without the scheme.
describe("hmac-sha256-ts: HMAC over `<unix-seconds>.<body>`, fresh within tolerance_seconds", () => {
  const check = (signed: { body: Buffer; headers: Record<string, string> }, now: Date, overrides: Record<string, unknown> = {}) =>
    verifyWebhookSignature({ route: route({ signature: "hmac-sha256-ts", ...overrides }), body: signed.body, headers: signed.headers, secret: SECRET, now });

  it("passes the timestamp in x-trent-timestamp and the digest in x-webhook-signature by default", () => {
    expect(check(timestampSigned({ id: "evt_1" }, NOW), new Date(NOW.getTime() + 299_000))).toEqual({ ok: true });
  });

  it("passes the Stripe-style form, t=<unix>,v1=<hex>, inside the signature header", () => {
    expect(check(timestampSigned({ id: "evt_1" }, NOW, { inline: true }), NOW)).toEqual({ ok: true });
  });

  it("refuses a correctly signed delivery 301 s old, or 301 s ahead, in either form", () => {
    for (const inline of [false, true]) {
      const signed = timestampSigned({ id: "evt_1" }, NOW, { inline });
      expect(check(signed, new Date(NOW.getTime() + 301_000)).ok).toBe(false);
      expect(check(signed, new Date(NOW.getTime() - 301_000)).ok).toBe(false);
    }
  });

  it("honours a route's own tolerance_seconds, timestamp_header and signature_header", () => {
    const signed = timestampSigned({ id: "evt_1" }, NOW, { signatureHeader: "X-Acme-Signature", timestampHeader: "X-Acme-Timestamp" });
    const headers = { signature_header: "X-Acme-Signature", timestamp_header: "X-Acme-Timestamp" };
    expect(check(signed, new Date(NOW.getTime() + 50_000), { ...headers, tolerance_seconds: 60 }).ok).toBe(true);
    expect(check(signed, new Date(NOW.getTime() + 61_000), { ...headers, tolerance_seconds: 60 }).ok).toBe(false);
    expect(check(signed, NOW).ok).toBe(false);
  });

  it("refuses a body-only MAC, a missing or non-numeric timestamp, and a timestamp changed after signing", () => {
    const signed = timestampSigned({ id: "evt_1" }, NOW);
    const bodyOnly = { ...signed.headers, "x-webhook-signature": hmacHex(SECRET, signed.body) };
    expect(check({ body: signed.body, headers: bodyOnly }, NOW).ok).toBe(false);
    const noTimestamp = Object.fromEntries(Object.entries(signed.headers).filter(([name]) => name !== "x-trent-timestamp"));
    expect(check({ body: signed.body, headers: noTimestamp }, NOW).ok).toBe(false);
    expect(check({ body: signed.body, headers: { ...signed.headers, "x-trent-timestamp": "yesterday" } }, NOW).ok).toBe(false);
    const moved = String(Math.floor(NOW.getTime() / 1000) + 10);
    expect(check({ body: signed.body, headers: { ...signed.headers, "x-trent-timestamp": moved } }, NOW).ok).toBe(false);
  });
});

describe("loopback addresses", () => {
  it("knows IPv4, IPv6 and IPv4-mapped loopback, and nothing else", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["10.0.0.5", "0.0.0.0", "::", "192.168.1.2", "::ffff:10.0.0.1", "", "localhost.evil.test"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});
