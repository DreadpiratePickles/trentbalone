/**
 * [H3] Signature verification per scheme, over the raw body, compared in constant time.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubSigned, hmacHex, route, SECRET, stripeSigned } from "./fakes.test-helpers.js";
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

describe("loopback addresses", () => {
  it("knows IPv4, IPv6 and IPv4-mapped loopback, and nothing else", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["10.0.0.5", "0.0.0.0", "::", "192.168.1.2", "::ffff:10.0.0.1", "", "localhost.evil.test"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});
