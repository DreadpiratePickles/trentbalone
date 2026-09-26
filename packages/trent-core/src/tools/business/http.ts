/**
 * The one HTTP path every business tool takes: the provider's base URL (fixed here, never
 * model-supplied), the token from `tokenResolver` (`connect/resolver.ts`; never `process.env`),
 * and a `fetch` that is the egress client (`tools/web/proxied-fetch.ts`) in production and a
 * direct transport pointed at a local fake in tests. A provider's error is returned as a
 * `ProviderRequestError` carrying the provider's own message; no request header is ever copied
 * into an error, a record or a log.
 *
 * [P2-14] Through the egress proxy the transport is wrapped in {@link withOwnCredential}, so the
 * proxy forwards the provider token this file sets and adds none of its own.
 *
 * Encodings, from the references cited in `docs/business.md`: Stripe and Twilio take
 * `application/x-www-form-urlencoded` (Stripe with bracketed nesting, `line_items[0][price]`);
 * Google Calendar and Square take JSON; Square wants a `Square-Version` date header.
 */
import type { ConnectProviderId } from "../../connect/providers.js";
import type { ResolvedToken } from "../../connect/resolver.js";
import { OWN_CREDENTIAL_HEADER } from "../../egress/CredentialBroker.js";
import { EXIT, TrentError } from "../../errors/index.js";
import type { FetchLike } from "../web/proxied-fetch.js";

export type BusinessProviderId = "stripe" | "google" | "square" | "twilio";

export const BUSINESS_PROVIDERS: readonly BusinessProviderId[] = ["stripe", "google", "square", "twilio"];

export const DEFAULT_ENDPOINTS: Readonly<Record<BusinessProviderId, string>> = {
  stripe: "https://api.stripe.com",
  google: "https://www.googleapis.com",
  square: "https://connect.squareup.com",
  twilio: "https://api.twilio.com",
};

/** The hosts the egress proxy must intercept for the toolset to reach anything. */
export const BUSINESS_HOSTS: readonly string[] = Object.values(DEFAULT_ENDPOINTS).map((url) => new URL(url).hostname);

/** The Square API version this adapter was written against (the reference page's current). */
export const SQUARE_VERSION = "2026-09-16";

export type TokenLookup = (id: ConnectProviderId) => Promise<ResolvedToken>;

export interface ProviderCall {
  readonly provider: BusinessProviderId;
  readonly method: "GET" | "POST" | "DELETE";
  /** Path and query, absolute from the provider's base; Twilio's account SID is filled by `{AccountSid}`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly form?: Readonly<Record<string, unknown>>;
  readonly json?: unknown;
  /** Stripe's `Idempotency-Key`; Square carries its key in the body instead. */
  readonly idempotencyKey?: string;
}

export interface ProviderReply {
  readonly status: number;
  readonly body: unknown;
}

export class ProviderRequestError extends TrentError {
  constructor(readonly provider: BusinessProviderId, readonly status: number, detail: string) {
    super({ code: EXIT.PROVIDER, operation: `business.${provider}`, message: `${provider} answered HTTP ${status}: ${detail}`, target: provider });
    this.name = "ProviderRequestError";
  }
}

export interface ProviderHttp {
  call(request: ProviderCall): Promise<ProviderReply>;
}

export interface ProviderHttpOptions {
  readonly fetchImpl: FetchLike;
  readonly endpoints?: Partial<Record<BusinessProviderId, string>>;
  readonly tokens: TokenLookup;
  readonly timeoutMs?: number;
}

/**
 * [P2-14] The egress transport as the business toolset uses it: every request, the provider call
 * and the token resolver's OAuth refresh alike, carries the broker's own-credential marker
 * (`egress/CredentialBroker.ts`). The proxy then keeps its allowlist and token gates but swaps
 * nothing in: without the marker it deletes the provider's Authorization and writes the credential
 * its token stands for (in the REPL, the model provider key) for Stripe, Square and Twilio, and an
 * `x-goog-api-key` for Google.
 */
export function withOwnCredential(fetchImpl: FetchLike): FetchLike {
  return ((input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(OWN_CREDENTIAL_HEADER, "1");
    return fetchImpl(input, { ...init, headers });
  }) as FetchLike;
}

/** Stripe's bracketed form encoding: `{line_items: [{price: "p"}]}` -> `line_items[0][price]=p`. */
export function encodeForm(value: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, item: unknown): void => {
    if (item === undefined || item === null) return;
    if (Array.isArray(item)) item.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
    else if (typeof item === "object") for (const [key, entry] of Object.entries(item as Record<string, unknown>)) walk(`${prefix}[${key}]`, entry);
    else params.append(prefix, String(item));
  };
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (Array.isArray(item) || typeof item === "object") walk(key, item);
    else params.append(key, String(item));
  }
  return params.toString();
}

/** The provider's own message out of its error body, with a bounded fallback on the raw text. */
function errorDetail(provider: BusinessProviderId, body: unknown, text: string): string {
  const record = body as Record<string, unknown> | null;
  if (record !== null && typeof record === "object") {
    if (provider === "stripe" || provider === "google") {
      const error = record.error as Record<string, unknown> | undefined;
      if (typeof error?.message === "string") return error.message;
    }
    if (provider === "square" && Array.isArray(record.errors)) {
      const first = record.errors[0] as Record<string, unknown> | undefined;
      if (typeof first?.detail === "string") return `${String(first.code ?? "")} ${first.detail}`.trim();
    }
    if (provider === "twilio" && typeof record.message === "string") return `${String(record.code ?? "")} ${record.message}`.trim();
  }
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function withQuery(base: string, path: string, query: ProviderCall["query"]): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

export function createProviderHttp(options: ProviderHttpOptions): ProviderHttp {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async call(request) {
      const token = await options.tokens(request.provider);
      const base = options.endpoints?.[request.provider] ?? DEFAULT_ENDPOINTS[request.provider];
      const path = request.provider === "twilio" ? request.path.replace("{AccountSid}", encodeURIComponent(token.username ?? "")) : request.path;
      const headers: Record<string, string> = { accept: "application/json" };
      if (request.provider === "twilio") headers.authorization = `Basic ${Buffer.from(`${token.username ?? ""}:${token.accessToken}`).toString("base64")}`;
      else headers.authorization = `Bearer ${token.accessToken}`;
      if (request.provider === "square") headers["square-version"] = SQUARE_VERSION;
      if (request.idempotencyKey !== undefined && request.provider === "stripe") headers["idempotency-key"] = request.idempotencyKey;
      let body: string | undefined;
      if (request.form !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = encodeForm(request.form as Record<string, unknown>);
      } else if (request.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(request.json);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await options.fetchImpl(withQuery(base, path.replace(/^\//, ""), request.query), { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (response.status < 200 || response.status >= 300) throw new ProviderRequestError(request.provider, response.status, errorDetail(request.provider, parsed, text));
      return { status: response.status, body: parsed };
    },
  };
}

/** Typed access into a provider's JSON reply; a missing field is the empty string, never a crash. */
export function field(body: unknown, ...path: string[]): string {
  let cursor: unknown = body;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return "";
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : typeof cursor === "number" ? String(cursor) : "";
}

export function numberField(body: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = body;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : typeof cursor === "string" && cursor !== "" && Number.isFinite(Number(cursor)) ? Number(cursor) : undefined;
}

export function listField(body: unknown, ...path: string[]): unknown[] {
  let cursor: unknown = body;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return [];
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? cursor : [];
}
