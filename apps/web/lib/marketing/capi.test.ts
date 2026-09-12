import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListMarketingAccounts,
  mockGetConversionEventByEventId,
  mockCreateConversionEvent,
  mockUpdateConversionEvent,
  mockGetMarketingPlatformAdapter,
  mockSendConversionEvent,
} = vi.hoisted(() => ({
  mockListMarketingAccounts: vi.fn(),
  mockGetConversionEventByEventId: vi.fn(),
  mockCreateConversionEvent: vi.fn(),
  mockUpdateConversionEvent: vi.fn(),
  mockGetMarketingPlatformAdapter: vi.fn(),
  mockSendConversionEvent: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    listMarketingAccounts: mockListMarketingAccounts,
    getConversionEventByEventId: mockGetConversionEventByEventId,
    createConversionEvent: mockCreateConversionEvent,
    updateConversionEvent: mockUpdateConversionEvent,
  },
}));

vi.mock("@/lib/marketing/platform-adapter", () => ({
  getMarketingPlatformAdapter: mockGetMarketingPlatformAdapter,
}));

import {
  ServerEventConsentRequiredError,
  buildServerEvent,
  hashUserData,
  isDuplicateEventIdError,
  sendServerEvent,
} from "./capi";

describe("marketing CAPI helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListMarketingAccounts.mockResolvedValue([marketingAccount({ consentForServerEvents: true })]);
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
      if (input.eventId === "evt_prisma_duplicate") {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
      }
      return {
        id: "conversion_1",
        createdAt: "2026-05-29T15:30:00.000Z",
        updatedAt: "2026-05-29T15:30:00.000Z",
        ...input,
      };
    });
    mockUpdateConversionEvent.mockImplementation(async (_id, patch) => ({
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
    }));
  });

  it("hashes email and phone after trim/lowercase normalization", () => {
    const hashed = hashUserData({
      email: "  Casey+Lead@Example.Test  ",
      phone: "  +1 555 010 1234  ",
    });

    expect(hashed).toEqual({
      em: sha256("casey+lead@example.test"),
      ph: sha256("+1 555 010 1234"),
    });
  });

  it("builds a normalized server event without raw PII in diagnostics", () => {
    const event = buildServerEvent({
      eventName: " Lead ",
      eventId: " evt_submit_1 ",
      occurredAt: "2026-05-29T15:30:00.000Z",
      sourceUrl: " https://example.test/signup ",
      fbp: " fbp.1.123 ",
      fbc: " fbc.1.456 ",
      email: "  Casey+Lead@Example.Test  ",
      phone: "  +1 555 010 1234  ",
    });
    const serialized = JSON.stringify(event);

    expect(event).toMatchObject({
      eventId: "evt_submit_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T15:30:00.000Z",
      sourceUrl: "https://example.test/signup",
      fbp: "fbp.1.123",
      fbc: "fbc.1.456",
      hashedUserData: {
        em: sha256("casey+lead@example.test"),
        ph: sha256("+1 555 010 1234"),
      },
    });
    expect(serialized).not.toContain("Casey+Lead@Example.Test");
    expect(serialized).not.toContain("casey+lead@example.test");
    expect(serialized).not.toContain("+1 555 010 1234");
  });

  it("throws a typed consent error when server-event consent is missing", async () => {
    mockListMarketingAccounts.mockResolvedValue([marketingAccount({ consentForServerEvents: false })]);

    await expect(sendServerEvent("co_1", "ma_1", buildServerEvent(baseInput()))).rejects.toBeInstanceOf(
      ServerEventConsentRequiredError
    );
    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("returns an existing event for duplicate eventId without resending", async () => {
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

    await expect(sendServerEvent("co_1", "ma_1", buildServerEvent(baseInput()))).resolves.toBe(existing);

    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("does not return an existing event from another company", async () => {
    mockGetConversionEventByEventId.mockResolvedValue({
      ...conversionEvent("co_other"),
      id: "conversion_other",
    });

    await expect(sendServerEvent("co_1", "ma_1", buildServerEvent(baseInput()))).rejects.toThrow(
      "Conversion event eventId already exists"
    );

    expect(mockSendConversionEvent).not.toHaveBeenCalled();
    expect(mockCreateConversionEvent).not.toHaveBeenCalled();
  });

  it("reserves the event before provider delivery so duplicate callers cannot both send", async () => {
    mockCreateConversionEvent.mockImplementationOnce(async (input) => {
      expect(mockSendConversionEvent).not.toHaveBeenCalled();
      return {
        ...conversionEvent("co_1"),
        ...input,
        id: "conversion_reserved",
        deliveryStatus: "pending",
      };
    });

    await expect(sendServerEvent("co_1", "ma_1", buildServerEvent(baseInput()))).resolves.toMatchObject({
      id: "conversion_1",
      deliveryStatus: "pending",
    });

    expect(mockSendConversionEvent).toHaveBeenCalledTimes(1);
  });

  it("treats Prisma unique violations as duplicate reservation errors", () => {
    expect(isDuplicateEventIdError(Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    }))).toBe(true);
  });
});

function baseInput() {
  return {
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

function conversionEvent(companyId: string) {
  return {
    id: "conversion_existing",
    companyId,
    eventId: "evt_submit_1",
    eventName: "Lead",
    occurredAt: "2026-05-29T15:30:00.000Z",
    hashedUserData: { em: "already_hashed" },
    deliveryStatus: "sent",
    diagnostics: { deduplicated: false },
    createdAt: "2026-05-29T15:30:00.000Z",
    updatedAt: "2026-05-29T15:30:00.000Z",
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
