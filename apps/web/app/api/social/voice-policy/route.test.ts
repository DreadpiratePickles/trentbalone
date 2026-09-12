import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockGetSocialVoicePolicy,
  mockUpsertSocialVoicePolicy,
  mockGetVoiceProfile,
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
  mockGetSocialVoicePolicy: vi.fn(),
  mockUpsertSocialVoicePolicy: vi.fn(),
  mockGetVoiceProfile: vi.fn(),
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
    getSocialVoicePolicy: mockGetSocialVoicePolicy,
    upsertSocialVoicePolicy: mockUpsertSocialVoicePolicy,
  },
}));

vi.mock("@/lib/brand/voice-memory", () => ({
  getVoiceProfile: mockGetVoiceProfile,
}));

import { GET, POST } from "./route";

describe("/api/social/voice-policy", () => {
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
    mockGetSocialVoicePolicy.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return voicePolicy();
    });
    mockUpsertSocialVoicePolicy.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return voicePolicy(input);
    });
    mockGetVoiceProfile.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return {
        toneMarkers: ["direct"],
        vocabularyStyle: "Short sentences.",
        prohibitedPhrases: ["synergy"],
        preferredCTAs: ["Start here"],
        sampleCount: 2,
        confidence: "medium",
        derivedAt: "2026-05-29T00:00:00.000Z",
      };
    });
  });

  it("GET enforces auth, viewer role, rate limit, and RLS before returning policy plus brand voice", async () => {
    const res = await GET(new Request("http://x/api/social/voice-policy?companyId=co_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetSocialVoicePolicy).toHaveBeenCalledWith("co_1");
    expect(mockGetVoiceProfile).toHaveBeenCalledWith("co_1");
    expect(body.policy.tone).toBe("plainspoken");
    expect(body.brandVoice.toneMarkers).toEqual(["direct"]);
  });

  it("POST enforces auth, member role, rate limit, RLS, and upserts a normalized policy", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      tone: " warm and specific ",
      hashtagPolicy: "Use up to two hashtags.",
      emojiPolicy: "Use one emoji max.",
      restrictedTerms: [" synergy ", "Synergy", "hype"],
      platformGuidance: { x: "Lead with proof.", linkedin: "Add founder context." },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockUpsertSocialVoicePolicy).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      tone: "warm and specific",
      restrictedTerms: ["synergy", "hype"],
      platformGuidance: { x: "Lead with proof.", linkedin: "Add founder context." },
    }));
    expect(body.policy.tone).toBe("warm and specific");
  });

  it("POST rejects content containing restricted terms before storing", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      tone: "warm",
      hashtagPolicy: "One hashtag.",
      emojiPolicy: "No emoji.",
      restrictedTerms: ["synergy"],
      platformGuidance: { x: "Concise." },
      content: "This synergy engine is live.",
      platform: "x",
    }));

    expect(res.status).toBe(400);
    expect(mockUpsertSocialVoicePolicy).not.toHaveBeenCalled();
  });

  it("validates required policy fields before RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", tone: "warm" }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/voice-policy", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function voicePolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: "socvoice_1",
    companyId: "co_1",
    tone: "plainspoken",
    hashtagPolicy: "Use one hashtag.",
    emojiPolicy: "Use emoji sparingly.",
    restrictedTerms: ["synergy"],
    platformGuidance: { x: "Stay concise." },
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}
