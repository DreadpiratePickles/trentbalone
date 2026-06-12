import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

const { mockCreateDocument } = vi.hoisted(() => ({
  mockCreateDocument: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    createDocument: mockCreateDocument,
  },
}));

import { POST } from "./route";

const savedEnv = { ...process.env };

function signSvix(payload: string, secret: string, id = "msg_test", timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = new Webhook(secret).sign(id, new Date(Number(timestamp) * 1000), payload);
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}

describe("POST /api/companies/[id]/email/resend/webhook", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    mockCreateDocument.mockReset();
    mockCreateDocument.mockImplementation(async (doc) => ({ ...doc, id: "doc_1", version: 1, createdAt: "now" }));
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("rejects inbound email webhooks when the signing secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await POST(new Request("http://x/api/companies/co_1/email/resend/webhook", {
      method: "POST",
      body: "{}",
    }), { params: Promise.resolve({ id: "co_1" }) });

    expect(res.status).toBe(503);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it("verifies Resend webhooks and stores inbound email evidence", async () => {
    const secret = `whsec_${Buffer.from("test_secret_32_bytes_for_hmac").toString("base64")}`;
    process.env.RESEND_WEBHOOK_SECRET = secret;
    const payload = JSON.stringify({
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
    const headers = signSvix(payload, secret);

    const res = await POST(new Request("http://x/api/companies/co_1/email/resend/webhook", {
      method: "POST",
      headers,
      body: payload,
    }), { params: Promise.resolve({ id: "co_1" }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, documentId: "doc_1" });
    expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      source: "resend:email.received:email_in_1",
    }));
  });
});
