import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockCreateSocialOutreachDraft,
  mockUpdateSocialOutreachDraft,
  mockCreateApproval,
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
  mockCreateSocialOutreachDraft: vi.fn(),
  mockUpdateSocialOutreachDraft: vi.fn(),
  mockCreateApproval: vi.fn(),
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
    createSocialOutreachDraft: mockCreateSocialOutreachDraft,
    updateSocialOutreachDraft: mockUpdateSocialOutreachDraft,
    createApproval: mockCreateApproval,
  },
}));

import { POST } from "./route";

describe("/api/social/outreach", () => {
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
    mockCreateSocialOutreachDraft.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        ...input,
        id: "draft_1",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
      };
    });
    mockCreateApproval.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        ...input,
        id: "approval_1",
        status: "pending",
        createdAt: "2026-05-29T00:00:00.000Z",
      };
    });
    mockUpdateSocialOutreachDraft.mockImplementation(async (id, patch) => {
      expect(rlsState.active).toBe(true);
      return {
        id,
        companyId: "co_1",
        contactId: "contact_1",
        platform: "linkedin",
        purpose: "ugc_collaboration",
        message: "Hi Maya",
        status: patch.status,
        approvalId: patch.approvalId,
        riskFlags: [],
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
      };
    });
  });

  it("requires auth, member role, rate limit, RLS, and creates approval-gated drafts only", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      purpose: "ugc_collaboration",
      context: "Invite a workflow clip.",
      contact: {
        id: "contact_1",
        companyId: "co_1",
        platform: "linkedin",
        externalContactId: "external_contact_1",
        handle: "@maya",
        displayName: "Maya Chen",
        engagementState: "engaged",
        optOutStatus: "not_opted_out",
        lastInboundAt: "2026-05-28T12:00:00.000Z",
        memory: { interests: ["founder workflows"] },
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockCreateSocialOutreachDraft).toHaveBeenCalledWith(expect.objectContaining({
      status: "draft",
      contactId: "contact_1",
    }));
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: "send_social_outreach",
    }));
    expect(mockUpdateSocialOutreachDraft).toHaveBeenCalledWith("draft_1", expect.objectContaining({
      status: "pending_approval",
      approvalId: "approval_1",
    }));
    expect(body.draft.approvalId).toBe("approval_1");
  });

  it("blocks opted-out contacts before creating drafts", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      purpose: "ugc_collaboration",
      contact: {
        id: "contact_1",
        companyId: "co_1",
        platform: "linkedin",
        externalContactId: "external_contact_1",
        optOutStatus: "opted_out",
        engagementState: "engaged",
        memory: {},
      },
    }));

    expect(res.status).toBe(409);
    expect(mockCreateSocialOutreachDraft).not.toHaveBeenCalled();
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/outreach", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
