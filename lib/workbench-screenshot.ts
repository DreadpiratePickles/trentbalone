/**
 * Playwright-based screenshot capture with responsive viewports.
 *
 * Falls back to an SVG placeholder when Playwright browsers are not installed.
 * Caller must run `npx playwright install chromium` for real screenshots.
 */

import type { WorkbenchScreenshotResult } from "@/lib/workbench-provider";
import { SteelBrowserClient } from "@/lib/steel-browser";
import { isLocalPreviewUrl } from "@/lib/workbench-preview";

// ── Viewport presets ──────────────────────────────────────────────────────────

export type ViewportName = "mobile" | "tablet" | "desktop";

export type Viewport = {
  name: ViewportName;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
};

export const VIEWPORTS: Record<ViewportName, Viewport> = {
  mobile: { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
  tablet: { name: "tablet", width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true },
  desktop: { name: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false },
};

export type ScreenshotOptions = {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeout?: number;
  fullPage?: boolean;
};

export type ResponsiveScreenshotResult = {
  viewport: Viewport;
  buffer: Buffer;
  dataUri: string;
};

// ── Availability check ────────────────────────────────────────────────────────

let _playwrightAvailable: boolean | null = null;
let _playwrightUnavailableReason = "";

const PLAYWRIGHT_CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

type ProbeBrowser = { close: () => Promise<void> };
type ProbeLauncher = () => Promise<ProbeBrowser>;

const defaultProbeLauncher: ProbeLauncher = async () => {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: PLAYWRIGHT_CHROMIUM_ARGS });
};

/** Test-only: clear the cached availability so a fresh probe runs next call. */
export function resetPlaywrightAvailabilityCacheForTests(): void {
  _playwrightAvailable = null;
  _playwrightUnavailableReason = "";
}

export async function isPlaywrightAvailable(launch: ProbeLauncher = defaultProbeLauncher): Promise<boolean> {
  // Cache positive results only. A negative is never cached: a transient
  // failure (e.g. an OOM-killed launch on a memory-constrained host) must not
  // permanently poison the flag and force every later screenshot to a
  // placeholder. Re-probe each call until a launch succeeds.
  if (_playwrightAvailable === true) return true;
  try {
    const browser = await launch();
    await browser.close();
    _playwrightAvailable = true;
    _playwrightUnavailableReason = "";
  } catch (err) {
    _playwrightAvailable = null;
    _playwrightUnavailableReason = errText(err);
  }
  return _playwrightAvailable === true;
}

// ── Core screenshot ───────────────────────────────────────────────────────────

/**
 * Take a screenshot of url at the given viewport. Returns a PNG buffer.
 * Throws if Playwright is not available — check isPlaywrightAvailable() first.
 */
export async function screenshotUrl(
  url: string,
  viewport: Viewport = VIEWPORTS.desktop,
  options: ScreenshotOptions & { extraHTTPHeaders?: Record<string, string> } = {},
): Promise<Buffer> {
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: true, args: PLAYWRIGHT_CHROMIUM_ARGS });
  try {
    const ctx = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: viewport.isMobile ?? false,
      extraHTTPHeaders: options.extraHTTPHeaders,
    });
    const page = await ctx.newPage();

    await page.goto(url, {
      waitUntil: options.waitUntil ?? "networkidle",
      timeout: options.timeout ?? 30_000,
    });

    const buf = await page.screenshot({
      type: "png",
      fullPage: options.fullPage ?? false,
    });

    await ctx.close();
    return buf;
  } finally {
    await browser.close();
  }
}

/**
 * Take screenshots at multiple viewports. Returns results for each.
 */
export async function screenshotResponsive(
  url: string,
  viewports: Viewport[] = Object.values(VIEWPORTS),
  options: ScreenshotOptions = {}
): Promise<ResponsiveScreenshotResult[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: PLAYWRIGHT_CHROMIUM_ARGS });
  const results: ResponsiveScreenshotResult[] = [];

  try {
    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor ?? 1,
        isMobile: vp.isMobile ?? false,
      });
      const page = await ctx.newPage();
      await page.goto(url, {
        waitUntil: options.waitUntil ?? "networkidle",
        timeout: options.timeout ?? 30_000,
      });
      const buffer = await page.screenshot({ type: "png", fullPage: options.fullPage ?? false });
      await ctx.close();

      results.push({
        viewport: vp,
        buffer,
        dataUri: `data:image/png;base64,${buffer.toString("base64")}`,
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}

// ── Provider-compatible screenshot (with SVG fallback) ────────────────────────

/**
 * Take a screenshot and return a WorkbenchScreenshotResult.
 * Falls back to an SVG placeholder if Playwright is unavailable.
 */
export async function captureScreenshot(
  url: string,
  options: {
    width?: number;
    height?: number;
    storageKey: string;
    sessionId: string;
    extraHTTPHeaders?: Record<string, string>;
    waitUntil?: ScreenshotOptions["waitUntil"];
    timeout?: number;
    _availabilityCheck?: () => Promise<boolean>;
  },
): Promise<WorkbenchScreenshotResult> {
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const failureReasons: string[] = [];
  const checkAvailable = options._availabilityCheck ?? isPlaywrightAvailable;

  const steelReachable = !isLocalPreviewUrl(url) || process.env.STEEL_ALLOW_LOCAL_URLS === "true";
  if (shouldUseSteelScreenshots() && steelReachable) {
    try {
      const buf = await screenshotUrlWithSteel(url);
      return {
        dataUri: `data:image/png;base64,${buf.toString("base64")}`,
        width,
        height,
        storageKey: options.storageKey,
      };
    } catch (err) {
      failureReasons.push(`Steel skipped: ${errText(err)}`);
    }
  }

  if (shouldUseCamofoxScreenshots()) {
    try {
      const buf = await screenshotUrlWithCamofox(url, options.sessionId);
      return {
        dataUri: `data:image/png;base64,${buf.toString("base64")}`,
        width,
        height,
        storageKey: options.storageKey,
      };
    } catch (err) {
      failureReasons.push(`Camofox failed: ${errText(err)}`);
    }
  }

  if (await checkAvailable()) {
    try {
      const vp: Viewport = { name: "desktop", width, height };
      const buf = await screenshotUrl(url, vp, {
        waitUntil: options.waitUntil ?? "networkidle",
        timeout: options.timeout ?? 30_000,
        extraHTTPHeaders: options.extraHTTPHeaders,
      });
      return {
        dataUri: `data:image/png;base64,${buf.toString("base64")}`,
        width,
        height,
        storageKey: options.storageKey,
      };
    } catch (err) {
      failureReasons.push(`Playwright failed: ${errText(err)}`);
    }
  } else if (_playwrightUnavailableReason) {
    failureReasons.push(`Playwright unavailable: ${_playwrightUnavailableReason}`);
  }

  return buildSvgPlaceholder(
    url,
    width,
    height,
    options.storageKey,
    options.sessionId,
    failureReasons.join(" | ") || "No browser screenshot backend was available",
  );
}

function shouldUseCamofoxScreenshots(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const provider = (env.WORKBENCH_SCREENSHOT_PROVIDER ?? env.WORKBENCH_BROWSER_PROVIDER ?? "").toLowerCase();
  return provider === "camofox";
}

function shouldUseSteelScreenshots(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const provider = (env.WORKBENCH_SCREENSHOT_PROVIDER ?? env.WORKBENCH_BROWSER_PROVIDER ?? "").toLowerCase();
  return provider === "steel" || provider === "steel-browser" || provider === "steel_browser";
}

async function screenshotUrlWithSteel(url: string): Promise<Buffer> {
  const client = new SteelBrowserClient();
  return client.screenshot({ url, fullPage: false, delayMs: 1000 });
}

async function screenshotUrlWithCamofox(url: string, sessionId: string): Promise<Buffer> {
  const { WorkbenchBrowserSession } = await import("@/lib/workbench-browser");
  const userId = `workbench_${sessionId.replace(/[^a-z0-9_-]/gi, "_")}`;
  const browser = new WorkbenchBrowserSession({
    provider: "camofox",
    userId,
    sessionKey: sessionId,
  });
  await browser.open();
  try {
    const nav = await browser.execute({ type: "navigate", url, waitUntil: "networkidle" });
    if (!nav.success) throw new Error(nav.error ?? "navigation failed");
    const shot = await browser.execute({ type: "screenshot" });
    if (!shot.success || !shot.screenshot) throw new Error(shot.error ?? "screenshot failed");
    return shot.screenshot;
  } finally {
    await browser.close();
  }
}

function buildSvgPlaceholder(
  url: string,
  width: number,
  height: number,
  storageKey: string,
  sessionId: string,
  reason: string,
): WorkbenchScreenshotResult {
  const safeReason = escapeSvgText(reason).slice(0, 220);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#0a0a0f"/>
  <rect x="0" y="0" width="${width}" height="40" fill="#0d0d14"/>
  <text x="20" y="26" font-family="monospace" font-size="12" fill="#6ee7b7">${escapeSvgText(url)}</text>
  <text x="${width / 2}" y="${height / 2 - 10}" font-family="monospace" font-size="14" fill="#8892a4" text-anchor="middle">Preview placeholder (browser screenshot unavailable)</text>
  <text x="${width / 2}" y="${height / 2 + 18}" font-family="monospace" font-size="11" fill="#4a5568" text-anchor="middle">Session ${escapeSvgText(sessionId.slice(-8))}</text>
  <text x="${width / 2}" y="${height / 2 + 42}" font-family="monospace" font-size="10" fill="#64748b" text-anchor="middle">${safeReason}</text>
</svg>`;
  return {
    dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    width,
    height,
    storageKey,
  };
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
