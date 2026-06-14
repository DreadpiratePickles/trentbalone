import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import {
  createResendEmailAdapter,
  extractCompanyKeyFromResendRecipients,
  parseResendInboundEmailEvent,
  persistResendInboundEmail,
  resendFromAddress,
  verifyResendWebhookSignature,
} from "./resend-email-adapter";

function signSvix(payload: string, secret: string, id = "msg_test", timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = new Webhook(secret).sign(id, new Date(Number(timestamp) * 1000), payload);
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}

describe("Resend email adapter", () => {
  it("fails closed without credentials instead of returning mocked success", async () => {
    const adapter = createResendEmailAdapter({
      env: {},
      fetchImpl: vi.fn(),
    });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute("send", {
      approvalId: "approval_1",
      to: "founder@example.com",
      from: "Trent <hello@trent.test>",
      subject: "Morning brief",
      text: "Here is the update.",
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("RESEND_AUTH_TOKEN");
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("accepts RESEND_AUTH_TOKEN and gates sends on approval", async () => {
    const adapter = createResendEmailAdapter({
      env: { RESEND_AUTH_TOKEN: "re_test", RESEND_FROM_EMAIL: "Trent <hello@trent.test>" },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        data: [{ name: "trent.test", status: "verified" }],
      }), { status: 200 })),
    });

    expect(adapter.availability).toBe("real");
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(adapter.requiresApproval("send")).toBe(true);

    const result = await adapter.execute("send", {
      to: "founder@example.com",
      from: "Trent <hello@trent.test>",
      subject: "Morning brief",
      text: "Here is the update.",
    });

    expect(result.status).toBe("needs_approval");
  });

  it("validates the Resend token during health checks instead of trusting env presence", async () => {
    const acceptedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ name: "let-trent.uk", status: "verified" }],
    }), { status: 200 }));
    const accepted = createResendEmailAdapter({
      env: {
        RESEND_AUTH_TOKEN: "re_valid",
        RESEND_FROM_DOMAIN: "let-trent.uk",
      },
      fetchImpl: acceptedFetch,
    });

    await expect(accepted.healthCheck()).resolves.toBe("connected");
    expect(acceptedFetch).toHaveBeenCalledWith("https://api.resend.com/domains", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer re_valid" }),
    }));

    const rejectedFetch = vi.fn(async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }));
    const rejected = createResendEmailAdapter({
      env: {
        RESEND_AUTH_TOKEN: "re_expired",
        RESEND_FROM_DOMAIN: "let-trent.uk",
      },
      fetchImpl: rejectedFetch,
    });

    await expect(rejected.healthCheck()).resolves.toBe("needs_credentials");
  });

  it("accepts a verified parent Resend domain for a configured sender subdomain", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ name: "let-trent.uk", status: "verified" }],
    }), { status: 200 }));
    const adapter = createResendEmailAdapter({
      env: {
        RESEND_AUTH_TOKEN: "re_valid",
        RESEND_FROM_DOMAIN: "send.let-trent.uk",
      },
      fetchImpl,
    });

    await expect(adapter.healthCheck()).resolves.toBe("connected");
  });

  it("sends approved email through the Resend API without leaking credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    const adapter = createResendEmailAdapter({
      env: { RESEND_AUTH_TOKEN: "re_secret", RESEND_FROM_EMAIL: "Trent <hello@trent.test>" },
      fetchImpl,
    });

    const result = await adapter.execute("send", {
      approvalId: "approval_1",
      to: ["founder@example.com"],
      subject: "Morning brief",
      html: "<p>Here is the update.</p>",
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer re_secret",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        from: "Trent <hello@trent.test>",
        to: ["founder@example.com"],
        subject: "Morning brief",
        html: "<p>Here is the update.</p>",
      }),
    }));
    expect(result).toEqual({
      adapter: "Email",
      action: "send",
      status: "completed",
      summary: "Resend accepted email email_123 for delivery to 1 recipient.",
    });
    expect(result.summary).not.toContain("re_secret");
  });

  it("normalizes send/mail subdomains to the verified root domain for default sender addresses", () => {
    expect(resendFromAddress({ RESEND_FROM_DOMAIN: "send.let-trent.uk" })).toBe("Trent <hello@let-trent.uk>");
    expect(resendFromAddress({ RESEND_FROM_DOMAIN: "mail.trent.test" })).toBe("Trent <hello@trent.test>");
  });

  it("uses the configured platform domain as a default Resend sender", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "email_456" }), { status: 200 }));
    const adapter = createResendEmailAdapter({
      env: { RESEND_API_KEY: "re_secret", RESEND_FROM_DOMAIN: "mail.trent.test" },
      fetchImpl,
    });

    const result = await adapter.execute("send", {
      approvalId: "approval_2",
      to: "founder@example.com",
      subject: "Morning brief",
      text: "Here is the update.",
    });

    expect(resendFromAddress({ RESEND_FROM_DOMAIN: "mail.trent.test" })).toBe("Trent <hello@trent.test>");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      body: JSON.stringify({
        from: "Trent <hello@trent.test>",
        to: ["founder@example.com"],
        subject: "Morning brief",
        text: "Here is the update.",
      }),
    }));
    expect(result.status).toBe("completed");
  });
});

describe("Resend inbound email handling", () => {
  it("verifies Svix webhook signatures with the raw body", () => {
    const payload = JSON.stringify({ type: "email.received", data: { email_id: "email_in_1" } });
    const secret = `whsec_${Buffer.from("test_secret_32_bytes_for_hmac").toString("base64")}`;
    const headers = signSvix(payload, secret);

    expect(verifyResendWebhookSignature({ payload, headers, secret })).toBe(true);
    expect(verifyResendWebhookSignature({ payload: `${payload} `, headers, secret })).toBe(false);
  });

  it("normalizes email.received events into a support memory document", async () => {
    const event = parseResendInboundEmailEvent({
      type: "email.received",
      data: {
        email_id: "email_in_1",
        from: "Customer <casey@example.com>",
        to: ["support@trent.test"],
        subject: "Need help",
        text: "Can you help with onboarding?",
        created_at: "2026-06-12T12:00:00.000Z",
      },
    });
    const createDocument = vi.fn(async (doc) => ({ ...doc, id: "doc_1", version: 1, createdAt: "now" }));

    const doc = await persistResendInboundEmail({
      companyId: "co_1",
      event,
      store: { createDocument },
    });

    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      type: "support_summary",
      source: "resend:email.received:email_in_1",
      memoryTier: "episodic",
      title: "Inbound email: Need help",
    }));
    expect(doc.content).toContain("From: Customer <casey@example.com>");
    expect(doc.content).toContain("Can you help with onboarding?");
  });

  it("routes inbound catch-all addresses to a company key without trusting unrelated domains", () => {
    const event = parseResendInboundEmailEvent({
      type: "email.received",
      data: {
        email_id: "email_in_2",
        from: "Customer <casey@example.com>",
        to: ["support+acme@inbound.trent.test", "random@elsewhere.test"],
        subject: "Need help",
      },
    });

    expect(extractCompanyKeyFromResendRecipients(event, {
      RESEND_INBOUND_DOMAIN: "inbound.trent.test",
    })).toBe("acme");
    expect(extractCompanyKeyFromResendRecipients(event, {
      RESEND_FROM_DOMAIN: "inbound.trent.test",
    })).toBe("acme");
    expect(extractCompanyKeyFromResendRecipients(event, {
      RESEND_INBOUND_DOMAIN: "other.trent.test",
    })).toBeUndefined();
  });
});
