/**
 * [H3] `gateway.webhooks` in the config schema: the route shape, and what it refuses.
 */
import { describe, expect, it } from "vitest";
import { TrentConfigSchema } from "../config/schema.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { WebhookRouteSchema, WebhooksConfigSchema } from "../config/sections/gateway.js";

const base = { name: "stripe-paid", path: "/hooks/stripe", secret_env: "STRIPE_WEBHOOK_SECRET", signature: "stripe", objective_template: "Invoice {{payload.data.object.id}} was paid" };

describe("gateway.webhooks.routes", () => {
  it("parses the H3 route shape with its defaults", () => {
    const parsed = WebhookRouteSchema.parse({ ...base, seat: "finance-ops", max_cost_cents: 50, dedupe_key: "{{payload.id}}" });
    expect(parsed).toMatchObject({ mode: "fleet", rate_per_minute: 30, tolerance_seconds: 300, seat: "finance-ops", max_cost_cents: 50, dedupe_key: "{{payload.id}}" });
  });

  it("takes an env NAME for the secret, never a value", () => {
    expect(WebhookRouteSchema.safeParse({ ...base, secret_env: "whsec_live_abc123" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...base, secret_env: undefined }).success).toBe(false);
  });

  it("refuses a secret on a localhost-only route, and a header on a non-generic scheme", () => {
    expect(WebhookRouteSchema.safeParse({ ...base, signature: "none-localhost-only" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...base, signature: "github", signature_header: "x-other" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...base, signature: "none-localhost-only", secret_env: undefined }).success).toBe(true);
  });

  it("refuses a template reference outside payload, and a prototype path", () => {
    expect(WebhookRouteSchema.safeParse({ ...base, objective_template: "{{env.HOME}}" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...base, dedupe_key: "{{payload.__proto__.x}}" }).success).toBe(false);
  });

  // [C8] The timestamped generic scheme: its own timestamp header, and the digest header it shares.
  it("parses hmac-sha256-ts with its headers, and keeps timestamp_header off every other scheme", () => {
    const ts = { ...base, signature: "hmac-sha256-ts", signature_header: "X-Acme-Signature", timestamp_header: "X-Acme-Timestamp", tolerance_seconds: 120 };
    expect(WebhookRouteSchema.parse(ts)).toMatchObject({ signature: "hmac-sha256-ts", signature_header: "X-Acme-Signature", timestamp_header: "X-Acme-Timestamp", tolerance_seconds: 120 });
    expect(WebhookRouteSchema.parse({ ...base, signature: "hmac-sha256-ts" }).timestamp_header).toBeUndefined();
    for (const signature of ["hmac-sha256", "stripe", "github"]) expect(WebhookRouteSchema.safeParse({ ...base, signature, timestamp_header: "X-Acme-Timestamp" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...ts, timestamp_header: "x acme" }).success).toBe(false);
  });

  it("keeps routes off the chat adapters' /webhooks/ prefix", () => {
    expect(WebhookRouteSchema.safeParse({ ...base, path: "/webhooks/telegram" }).success).toBe(false);
    expect(WebhookRouteSchema.safeParse({ ...base, path: "hooks/no-slash" }).success).toBe(false);
  });

  it("refuses duplicate names or paths, and a localhost-only route on a non-loopback listener", () => {
    const local = { ...base, name: "local", path: "/hooks/local", signature: "none-localhost-only", secret_env: undefined };
    expect(WebhooksConfigSchema.safeParse({ routes: [base, { ...base, path: "/hooks/other" }] }).success).toBe(false);
    expect(WebhooksConfigSchema.safeParse({ routes: [base, { ...base, name: "other" }] }).success).toBe(false);
    expect(WebhooksConfigSchema.safeParse({ host: "0.0.0.0", routes: [local] }).success).toBe(false);
    expect(WebhooksConfigSchema.parse({ routes: [local] })).toMatchObject({ host: "127.0.0.1", port: 8644 });
  });

  it("is optional under gateway, so the shipped defaults parse unchanged", () => {
    expect((TrentConfigSchema.parse(DEFAULT_CONFIG) as { gateway: Record<string, unknown> }).gateway.webhooks).toBeUndefined();
    const withRoutes = TrentConfigSchema.parse({ ...DEFAULT_CONFIG, gateway: { ...DEFAULT_CONFIG.gateway, webhooks: { routes: [base] } } });
    expect(withRoutes.gateway.webhooks?.routes[0]?.name).toBe("stripe-paid");
  });
});
