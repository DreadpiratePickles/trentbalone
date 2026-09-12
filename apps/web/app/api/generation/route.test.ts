import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGenerateText,
  mockGenerateImage,
  mockGenerateAudio,
  mockSubmitVideoJob,
  mockSubmitMusicJob,
  mockGetCompany,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGenerateText: vi.fn(),
  mockGenerateImage: vi.fn(),
  mockGenerateAudio: vi.fn(),
  mockSubmitVideoJob: vi.fn(),
  mockSubmitMusicJob: vi.fn(),
  mockGetCompany: vi.fn(),
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
  },
}));

vi.mock("@/lib/generation/text-router", () => ({
  generateText: mockGenerateText,
}));

vi.mock("@/lib/generation/image-router", () => ({
  generateImage: mockGenerateImage,
}));

vi.mock("@/lib/generation/audio-router", () => ({
  generateAudio: mockGenerateAudio,
}));

vi.mock("@/lib/generation/video-router", () => ({
  submitVideoJob: mockSubmitVideoJob,
}));

vi.mock("@/lib/generation/music-router", () => ({
  submitMusicJob: mockSubmitMusicJob,
}));

import { POST } from "./route";

describe("/api/generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockGenerateText.mockResolvedValue({ text: "Generated copy", usage: { costCents: 1 } });
    mockGenerateImage.mockResolvedValue({ provider: "openai", imageUrl: "https://cdn.test/image.png" });
    mockGenerateAudio.mockResolvedValue({ provider: "elevenlabs", audioUrl: "https://cdn.test/audio.mp3" });
    mockSubmitVideoJob.mockResolvedValue({ id: "vid_1", status: "queued" });
    mockSubmitMusicJob.mockResolvedValue({ id: "music_1", status: "queued" });
  });

  it("requires auth", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await POST(jsonRequest({ companyId: "co_1", type: "text", prompt: "write" }));
    expect(res.status).toBe(401);
  });

  it("validates companyId and type", async () => {
    const res = await POST(jsonRequest({ prompt: "write" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the selected generation type is missing required input", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", type: "audio" }));
    expect(res.status).toBe(400);
  });

  it("requires member role for company generation", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await POST(jsonRequest({ companyId: "co_1", type: "text", prompt: "write" }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
  });

  it("fails closed when the company rate limit is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(jsonRequest({ companyId: "co_1", type: "text", prompt: "write" }));
    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(30);
  });

  it("runs text generation inside RLS context", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      type: "text",
      qualityTier: "premium",
      prompt: "write a homepage hero",
      systemPrompt: "stay concise",
    }));

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      qualityTier: "premium",
      prompt: "write a homepage hero",
      systemPrompt: "stay concise",
    }));
  });

  it.each([
    ["image", mockGenerateImage, { prompt: "draw", width: 512, height: 512 }],
    ["audio", mockGenerateAudio, { text: "read this", voiceId: "voice_1" }],
    ["video", mockSubmitVideoJob, { prompt: "make a reel", durationSeconds: 8 }],
    ["music", mockSubmitMusicJob, { prompt: "make a jingle", genre: "electronic" }],
  ])("dispatches %s requests to the matching router", async (type, mockFn, body) => {
    const res = await POST(jsonRequest({ companyId: "co_1", type, ...body }));

    expect(res.status).toBe(200);
    expect(mockFn).toHaveBeenCalledWith(expect.objectContaining({ companyId: "co_1" }));
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/generation", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
