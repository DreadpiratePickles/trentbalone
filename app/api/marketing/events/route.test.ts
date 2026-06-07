import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockListMarketingAccounts,
  mockGetConversionEventByEventId,
  mockCreateConversionEvent,
  mockUpdateConversionEvent,
  mockGetMarketingPlatformAdapter,
  mockSendConversionEvent,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockGetCompany: vi.fn(),
  mockListMarketingAccounts: vi.fn(),
    mockGetConversionEventByEventId: vi.fn(),
    mockCreateConversionEvent: vi.fn(),
    mockUpdateConversionEvent: vi.fn(),
    mockGetMarketingPlatformAdapter: vi.fn(),
    mockSendConversionEvent: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listMarketingAccounts: mockListMarketingAccounts,
    getConversionEventByEventId: mockGetConversionEventByEventId,
    createConversionEvent: mockCreateConversionEvent,
    updateConversionEvent: mockUpdateConversionEvent,
  },
}));

vi.mock("@/lib/marketing/platform-adapter", () => ({
  getMarketingPlatformAdapter: mockGetMarketingPlatformAdapter,
}));

import { POST } from "./route";

describe("POST /api/marketing/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockListMarketingAccounts.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [marketingAccount({ consentForServerEvents: true })];
    });
    mockGetConversionEventByEventId.mockResolvedValue(undefined);
    mockSendConversionEvent.mockResolvedValue({
      platform: "meta",
      eventId: "evt_submit_1",
      delivered: false,
      status: "sandbox",
    });
    mockGetMarketingPlatformAdapter.mockReturnValue({
      platform: "meta",
      sendConversionEvent: mockSendConversionEvent,
    });
    mockCreateConversionEvent.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        id: "conversion_1",
        createdAt: "2026-05-29T15:30:00.000Z",
        updatedAt: "2026-05-29T15:30:00.000Z",
        ...input,
      };
    });
    mockUpdateConversionEvent.mockImplementation(async (_id, patch) => {
      expect(rlsState.active).toBe(true);
      return {
        id: "conversion_1",
        companyId: "co_1",
        eventId: "evt_submit_1",
        eventName: "Lead",
        occurredAt: "2026-05-29T15:30:00.000Z",
        hashedUserData: { em: "already_hashed" },
        deliveryStatus: patch.deliveryStatus ?? "sent",
        diagnostics: patch.diagnostics ?? {},
        createdAt: "2026-05-29T15:30:00.000Z",
        updatedAt: "2026-05-29T15:30:01.000Z",
      };
    });
  });

  it("requires auth", async () => {
    mockGetAuthUser.mockResolvedValue(null);

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(401);
  });

  it("requires member role, rate limit, and RLS before storing the event", async () => {
    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockCreateConversionEvent).toHaveBeenCalledTimes(1);
  });

  it("hashes PII before persistence and never returns raw email or phone", async () => {
    const res = await POST(jsonRequest(validBody()));
    const body = await res.json();
    const persistedInput = mockCreateConversionEvent.mock.calls[0][0];
    const serializedResponse = JSON.stringify(body);
    const serializedPersisted = JSON.stringify(persistedInput);

    expect(persistedInput.hashedUserData).toEqual({
      em: expect.stringMatching(/^[a-f0-9]{64}$/),
      ph: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(serializedPersisted).not.toContain("Casey+Lead@Example.Test");
    expect(serializedPersisted).not.toContain("+1 555 010 1234");
    expect(serializedResponse).not.toContain("Casey+Lead@Example.Test");
    expect(serializedResponse).not.toContain("+1 555 010 1234");
  });

  it("returns existing event for duplicate eventId without resending", async () => {
    const existing = {
      id: "conversion_existing",
      companyId: "co_1",
      eventId: "evt_submit_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T15:30:00.000Z",
      hashedUserData: { em: "already_hashed" },
      deliveryStatus: "sent",
      diagnostics: { deduplicated: false },
      createdAt: "2026-05-29T15:30:00.000Z",
      updatedAt: "2026-05-29T15:30:00.000Z",
    };
    mockGetConversionEventByEventId.mockResolvedValue(existing);

    const res = await POST(jsonRequest(validBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.event.id).toBe("conversion_existing");
    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("does not return a duplicate event owned by another company", async () => {
    mockGetConversionEventByEventId.mockResolvedValue({
      id: "conversion_other",
      companyId: "co_other",
      eventId: "evt_submit_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T15:30:00.000Z",
      hashedUserData: { em: "already_hashed" },
      deliveryStatus: "sent",
      diagnostics: { deduplicated: false },
      createdAt: "2026-05-29T15:30:00.000Z",
      updatedAt: "2026-05-29T15:30:00.000Z",
    });

    const res = await POST(jsonRequest(validBody()));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("Conversion event eventId already exists");
    expect(JSON.stringify(body)).not.toContain("co_other");
    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when server-event consent is missing", async () => {
    mockListMarketingAccounts.mockResolvedValue([marketingAccount({ consentForServerEvents: false })]);

    const res = await POST(jsonRequest(validBody()));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("Server event consent is required");
    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when the submitted marketing account is not in the tenant", async () => {
    mockListMarketingAccounts.mockResolvedValue([]);

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(404);
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("returns 403 when caller lacks member role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(30);
  });
});

function validBody() {
  return {
    companyId: "co_1",
    marketingAccountId: "ma_1",
    eventName: "Lead",
    eventId: "evt_submit_1",
    occurredAt: "2026-05-29T15:30:00.000Z",
    sourceUrl: "https://example.test/signup",
    fbp: "fbp.1.123",
    fbc: "fbc.1.456",
    email: "Casey+Lead@Example.Test",
    phone: "+1 555 010 1234",
  };
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/events", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function marketingAccount(patch: { consentForServerEvents: boolean }) {
  return {
    id: "ma_1",
    companyId: "co_1",
    platform: "meta",
    status: "active",
    externalAccountId: "act_123",
    currency: "USD",
    paymentStatus: "ready",
    consentForServerEvents: patch.consentForServerEvents,
    createdAt: "2026-05-29T15:00:00.000Z",
    updatedAt: "2026-05-29T15:00:00.000Z",
  };
}
