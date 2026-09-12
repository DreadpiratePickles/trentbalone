import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHttpPreview, parsePortFromCommand, DEFAULT_PREVIEW_PORT, probeBrowserPreviewDom } from "@/lib/workbench-cloud-preview";

const {
  mockBrowserClose,
  mockGoto,
  mockEvaluate,
  mockNewPage,
  mockWaitForLoadState,
  mockWaitForTimeout,
  mockWaitForSelector,
  mockContent,
  mockCaptureScreenshot,
} = vi.hoisted(() => ({
  mockBrowserClose: vi.fn(),
  mockGoto: vi.fn(),
  mockEvaluate: vi.fn(),
  mockNewPage: vi.fn(),
  mockWaitForLoadState: vi.fn(),
  mockWaitForTimeout: vi.fn(),
  mockWaitForSelector: vi.fn(),
  mockContent: vi.fn(),
  mockCaptureScreenshot: vi.fn(),
}));

vi.mock("@/lib/workbench-screenshot", () => ({
  captureScreenshot: mockCaptureScreenshot,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      close: mockBrowserClose,
      newPage: mockNewPage,
    })),
  },
}));

function mockHydratedPage() {
  mockGoto.mockResolvedValue({ status: () => 200 });
  mockWaitForLoadState.mockResolvedValue(undefined);
  mockWaitForTimeout.mockResolvedValue(undefined);
  mockWaitForSelector.mockResolvedValue(undefined);
  mockContent.mockResolvedValue("<html><body><button>Save note</button><p>Cloud Notes</p></body></html>");
  mockEvaluate.mockResolvedValue({
    bodyText: "Cloud Notes Save note Capture the idea",
    visibleElements: 5,
  });
  mockNewPage.mockResolvedValue({
    goto: mockGoto,
    waitForLoadState: mockWaitForLoadState,
    waitForTimeout: mockWaitForTimeout,
    waitForSelector: mockWaitForSelector,
    content: mockContent,
    getByText: vi.fn(() => ({
      first: () => ({
        waitFor: vi.fn().mockRejectedValue(new Error("not yet")),
      }),
    })),
    evaluate: mockEvaluate,
    on: vi.fn(),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockCaptureScreenshot.mockResolvedValue({
    dataUri: "data:image/png;base64,cmVhbC1wbmc=",
    width: 1280,
    height: 720,
    storageKey: "proof.png",
  });
});

describe("parsePortFromCommand", () => {
  it("parses --port with a space", () => {
    expect(parsePortFromCommand("vite --host 0.0.0.0 --port 3000")).toBe(3000);
  });
  it("parses --port with equals", () => {
    expect(parsePortFromCommand("npm run dev -- --port=4200")).toBe(4200);
  });
  it("parses -p short flag", () => {
    expect(parsePortFromCommand("serve -p 8080 dist")).toBe(8080);
  });
  it("parses PORT= env prefix", () => {
    expect(parsePortFromCommand("PORT=5000 node server.js")).toBe(5000);
  });
  it("returns undefined when no port is present", () => {
    expect(parsePortFromCommand("npm run dev")).toBeUndefined();
  });
  it("defaults to port 3000", () => {
    expect(DEFAULT_PREVIEW_PORT).toBe(3000);
  });
});

describe("inspectHttpPreview", () => {
  it("uses browser-rendered DOM evidence instead of static Vite HTML shell text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      text: async () => "<html><head><title>Cloud Notes Proof</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
    })));
    mockHydratedPage();

    const result = await inspectHttpPreview("https://preview.example", {
      dataUri: "data:image/png;base64,real",
      width: 1280,
      height: 720,
      storageKey: "proof.png",
    });

    expect(result.httpStatus).toBe(200);
    expect(result.domText).toContain("Cloud Notes Save note");
    expect(result.domText).not.toBe("Cloud Notes Proof");
    expect(result.visibleElements).toBe(5);
    expect(result.diagnostics?.domProbeSource).toBe("browser");
    expect(result.pageErrors).toEqual([]);
    expect(mockBrowserClose).toHaveBeenCalled();
  });

  it("does not pass when only the SPA shell is visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      text: async () => "<html><body><div id=\"root\"></div></body></html>",
    })));
    mockGoto.mockResolvedValue({ status: () => 200 });
    mockWaitForLoadState.mockResolvedValue(undefined);
    mockWaitForTimeout.mockResolvedValue(undefined);
    mockWaitForSelector.mockRejectedValue(new Error("no elements"));
    mockContent.mockResolvedValue("<html><body><div id=\"root\"></div></body></html>");
    mockEvaluate.mockResolvedValue({ bodyText: "Cloud Notes Proof", visibleElements: 0 });
    mockNewPage.mockResolvedValue({
      goto: mockGoto,
      waitForLoadState: mockWaitForLoadState,
      waitForTimeout: mockWaitForTimeout,
      waitForSelector: mockWaitForSelector,
      content: mockContent,
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn().mockRejectedValue(new Error("no")) }) })),
      evaluate: mockEvaluate,
      on: vi.fn(),
    });

    const result = await probeBrowserPreviewDom("https://preview.example", {
      trafficAccessToken: "token",
      hydrationTimeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.visibleElements).toBe(0);
    expect(result.hydrationWaitReason).toContain("hydration timeout");
  });

  it("passes proxy auth header to Playwright without logging the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, text: async () => "ok" })));
    mockHydratedPage();

    await inspectHttpPreview("https://preview.example", {
      trafficAccessToken: "secret-token",
      screenshotCapture: { storageKey: "proof.png", sessionId: "ws_1" },
    });

    expect(mockNewPage).toHaveBeenCalledWith(expect.objectContaining({
      extraHTTPHeaders: { "X-Access-Token": "secret-token" },
    }));
    expect(mockCaptureScreenshot).toHaveBeenCalledWith(
      "https://preview.example",
      expect.objectContaining({
        extraHTTPHeaders: { "X-Access-Token": "secret-token" },
      }),
    );
  });
});
