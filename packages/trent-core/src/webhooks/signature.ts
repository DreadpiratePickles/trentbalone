/**
 * [H3] Signature verification over the RAW body, before the body is parsed or anything else is
 * read. Every comparison is `crypto.timingSafeEqual` over two 32-byte digests, after the offered
 * value has been checked to be exactly 64 hex characters, so neither the length nor an early
 * mismatch leaks through timing.
 *
 *   github       `X-Hub-Signature-256: sha256=<hex>` over the body.
 *   stripe       `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]` over `<t>.<body>`; `t` within
 *                `tolerance_seconds` of this host's clock either way; any one v1 may match (Stripe
 *                sends one per active secret while a secret is being rolled).
 *   hmac-sha256  `<signature_header>: [sha256=]<hex>` over the body; header default x-webhook-signature.
 *
 * `none-localhost-only` has no signature: the engine checks the peer and the listener instead.
 */
import crypto from "node:crypto";
import type { WebhookRoute } from "../config/sections/gateway.js";

export const DEFAULT_SIGNATURE_HEADER = "x-webhook-signature";
const HEX_DIGEST = /^[0-9a-f]{64}$/i;

export type SignatureVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface SignatureInput {
  readonly route: Pick<WebhookRoute, "signature" | "signature_header" | "tolerance_seconds">;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly secret: string;
  readonly now: Date;
}

const refuse = (reason: string): SignatureVerdict => ({ ok: false, reason });

function digest(secret: string, data: Buffer): Buffer {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

/** Constant-time: the offered hex must be a full digest before it is compared at all. */
function matches(expected: Buffer, offeredHex: string): boolean {
  if (!HEX_DIGEST.test(offeredHex)) return false;
  return crypto.timingSafeEqual(expected, Buffer.from(offeredHex, "hex"));
}

function header(headers: SignatureInput["headers"], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function prefixed(value: string): string {
  return value.toLowerCase().startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function verifyStripe(input: SignatureInput): SignatureVerdict {
  const raw = header(input.headers, "stripe-signature");
  if (raw === undefined) return refuse("no Stripe-Signature header");
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1") v1.push(value);
  }
  if (t === undefined || !/^\d{1,12}$/.test(t)) return refuse("Stripe-Signature has no timestamp");
  if (v1.length === 0) return refuse("Stripe-Signature has no v1 signature");
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - Number(t));
  if (skew > input.route.tolerance_seconds) return refuse(`Stripe-Signature timestamp is ${String(skew)}s from this host's clock (tolerance ${String(input.route.tolerance_seconds)}s)`);
  const expected = digest(input.secret, Buffer.concat([Buffer.from(`${t}.`, "utf8"), input.body]));
  // Every candidate is compared, so which one matched does not show in the timing either.
  let ok = false;
  for (const candidate of v1) ok = matches(expected, candidate) || ok;
  return ok ? { ok: true } : refuse("no v1 signature matches");
}

export function verifyWebhookSignature(input: SignatureInput): SignatureVerdict {
  if (input.secret === "") return refuse("the route's secret is empty");
  switch (input.route.signature) {
    case "stripe":
      return verifyStripe(input);
    case "github": {
      const raw = header(input.headers, "x-hub-signature-256");
      if (raw === undefined) return refuse("no X-Hub-Signature-256 header");
      if (!raw.toLowerCase().startsWith("sha256=")) return refuse("X-Hub-Signature-256 is not sha256=<hex>");
      return matches(digest(input.secret, input.body), prefixed(raw)) ? { ok: true } : refuse("signature mismatch");
    }
    case "hmac-sha256": {
      const name = input.route.signature_header ?? DEFAULT_SIGNATURE_HEADER;
      const raw = header(input.headers, name);
      if (raw === undefined) return refuse(`no ${name} header`);
      return matches(digest(input.secret, input.body), prefixed(raw)) ? { ok: true } : refuse("signature mismatch");
    }
    default:
      return refuse(`${input.route.signature} has no signature to verify`);
  }
}

/** 127.0.0.0/8, ::1, and the IPv4-mapped form of 127.0.0.0/8. Nothing named, nothing wildcard. */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.toLowerCase().startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (bare === "::1") return true;
  const octets = bare.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
