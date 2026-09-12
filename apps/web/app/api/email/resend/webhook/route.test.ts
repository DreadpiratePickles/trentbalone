import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateDocument, mockGetCompany } = vi.hoisted(() => ({
  mockCreateDocument: vi.fn(),
  mockGetCompany: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    createDocument: mockCreateDocument,
    getCompany: mockGetCompany,
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

describe("POST /api/email/resend/webhook", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    process.env.RESEND_INBOUND_DOMAIN = "inbound.trent.test";
    mockCreateDocument.mockReset();
    mockGetCompany.mockReset();
    mockGetCompany.mockResolvedValue({ id: "co_1", slug: "acme" });
    mockCreateDocument.mockImplementation(async (doc) => ({ ...doc, id: "doc_1", version: 1, createdAt: "now" }));
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("routes a verified inbound email to the matching company inbox memory", async () => {
    const secret = `whsec_${Buffer.from("test_secret_32_bytes_for_hmac").toString("base64")}`;
    process.env.RESEND_WEBHOOK_SECRET = secret;
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "email_in_1",
        from: "Customer <casey@example.com>",
        to: ["support+acme@inbound.trent.test"],
        subject: "Need help",
      },
    });

    const res = await POST(new Request("http://x/api/email/resend/webhook", {
      method: "POST",
      headers: signSvix(payload, secret),
      body: payload,
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, companyId: "co_1", documentId: "doc_1" });
    expect(mockGetCompany).toHaveBeenCalledWith("acme");
    expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      source: "resend:email.received:email_in_1",
    }));
  });

  it("accepts but does not retry unroutable inbound emails", async () => {
    const secret = `whsec_${Buffer.from("test_secret_32_bytes_for_hmac").toString("base64")}`;
    process.env.RESEND_WEBHOOK_SECRET = secret;
    const payload = JSON.stringify({
      type: "email.received",
      data: {
        email_id: "email_in_2",
        from: "Customer <casey@example.com>",
        to: ["support@unknown.test"],
        subject: "Need help",
      },
    });

    const res = await POST(new Request("http://x/api/email/resend/webhook", {
      method: "POST",
      headers: signSvix(payload, secret),
      body: payload,
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: "No configured company address matched this Resend inbound email.",
    });
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });
});
