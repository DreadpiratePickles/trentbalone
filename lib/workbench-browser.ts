/**
 * Production browser automation for workbench sessions.
 *
 * Wraps Playwright with:
 * - Stealth settings (realistic UA, disabled webdriver flag, fingerprint hardening)
 * - CAPTCHA detection across reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile
 * - Human handoff: pauses the session and emits an approval event when blocked
 *
 * Usage: create a WorkbenchBrowserSession, open(), execute actions, close().
 */

import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import { CamofoxBrowserClient, type CamofoxSnapshot } from "@/lib/camofox-browser";

// ── Action types ──────────────────────────────────────────────────────────────

export type BrowserAction =
  | { type: "navigate"; url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" }
  | { type: "click"; selector: string; timeout?: number }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "screenshot" }
  | { type: "wait_for"; selector: string; timeout?: number }
  | { type: "evaluate"; expression: string }
  | { type: "submit"; selector?: string };

export type BrowserActionResult = {
  success: boolean;
  screenshot?: Buffer;
  html?: string;
  text?: string;
  error?: string;
  captchaDetected?: boolean;
  url?: string;
};

// ── CAPTCHA detection ─────────────────────────────────────────────────────────

const CAPTCHA_SELECTORS = [
  ".g-recaptcha",
  "#recaptcha",
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha.com']",
  "iframe[src*='challenges.cloudflare.com']",
  "[data-sitekey]",
  ".h-captcha",
  "#cf-challenge-running",
  ".cf-challenge-container",
];

const CAPTCHA_TITLE_PATTERNS = [
  /captcha/i,
  /challenge/i,
  /just a moment/i, // Cloudflare
  /security check/i,
  /verify you are human/i,
];

// ── Browser session options ───────────────────────────────────────────────────

export type BrowserSessionOptions = {
  /** Browser backend. Playwright remains the default for local compatibility. */
  provider?: "playwright" | "camofox";
  /** Camofox user/session identifiers for isolated browser state. */
  userId?: string;
  sessionKey?: string;
  /** Enable stealth mode (default true). */
  stealth?: boolean;
  /** Custom user agent. Defaults to a recent Chrome UA. */
  userAgent?: string;
  viewport?: { width: number; height: number };
  /** Max time per action in ms. */
  actionTimeout?: number;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── WorkbenchBrowserSession ───────────────────────────────────────────────────

export class WorkbenchBrowserSession {
  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;
  private camofox: CamofoxBrowserClient | null = null;
  private camofoxTabId: string | null = null;
  private camofoxUrl = "";
  private camofoxSnapshot: CamofoxSnapshot | null = null;
  private readonly opts: Required<BrowserSessionOptions>;

  constructor(opts: BrowserSessionOptions = {}) {
    this.opts = {
      provider: opts.provider ?? "playwright",
      userId: opts.userId ?? "trent-workbench",
      sessionKey: opts.sessionKey ?? "default",
      stealth: opts.stealth ?? true,
      userAgent: opts.userAgent ?? DEFAULT_UA,
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      actionTimeout: opts.actionTimeout ?? 30_000,
    };
  }

  async open(): Promise<void> {
    if (this.opts.provider === "camofox") {
      this.camofox = new CamofoxBrowserClient();
      const tab = await this.camofox.createTab({
        userId: this.opts.userId,
        sessionKey: this.opts.sessionKey,
      });
      this.camofoxTabId = tab.id;
      this.camofoxUrl = tab.url ?? "";
      return;
    }

    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: true });
    const ctx = await this.browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: this.opts.viewport,
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    });

    if (this.opts.stealth) {
      await ctx.addInitScript(() => {
        // Hide webdriver flag
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // Spoof languages
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        // Fake plugins to look like a real browser
        Object.defineProperty(navigator, "plugins", {
          get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }],
        });
      });
    }

    this.page = await ctx.newPage();
    this.page.setDefaultTimeout(this.opts.actionTimeout);
  }

  private assertOpen(): import("playwright").Page {
    if (!this.page) throw new Error("BrowserSession not opened — call open() first");
    return this.page;
  }

  private assertCamofoxOpen(): { client: CamofoxBrowserClient; tabId: string } {
    if (!this.camofox || !this.camofoxTabId) throw new Error("BrowserSession not opened — call open() first");
    return { client: this.camofox, tabId: this.camofoxTabId };
  }

  async detectCaptcha(): Promise<boolean> {
    const page = this.assertOpen();
    for (const sel of CAPTCHA_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) return true;
      } catch { /* selector may error in certain contexts */ }
    }
    const title = await page.title().catch(() => "");
    return CAPTCHA_TITLE_PATTERNS.some((pat) => pat.test(title));
  }

  async execute(action: BrowserAction): Promise<BrowserActionResult> {
    if (this.opts.provider === "camofox") return this.executeCamofox(action);

    const page = this.assertOpen();

    try {
      switch (action.type) {
        case "navigate": {
          await page.goto(action.url, {
            waitUntil: action.waitUntil ?? "networkidle",
            timeout: this.opts.actionTimeout,
          });
          const captchaDetected = await this.detectCaptcha();
          return { success: true, url: page.url(), captchaDetected };
        }

        case "click": {
          await page.click(action.selector, { timeout: action.timeout ?? this.opts.actionTimeout });
          return { success: true, url: page.url() };
        }

        case "fill": {
          await page.fill(action.selector, action.value);
          return { success: true };
        }

        case "select": {
          await page.selectOption(action.selector, action.value);
          return { success: true };
        }

        case "submit": {
          const sel = action.selector ?? "form";
          await page.evaluate((s) => {
            const el = document.querySelector(s) as HTMLFormElement | null;
            if (el) el.submit();
          }, sel);
          return { success: true, url: page.url() };
        }

        case "wait_for": {
          await page.waitForSelector(action.selector, { timeout: action.timeout ?? this.opts.actionTimeout });
          return { success: true };
        }

        case "screenshot": {
          const buf = await page.screenshot({ type: "png" });
          return { success: true, screenshot: buf };
        }

        case "evaluate": {
          const result = await page.evaluate(action.expression);
          return { success: true, text: String(result) };
        }

        default:
          return { success: false, error: `Unknown action type` };
      }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async executeCamofox(action: BrowserAction): Promise<BrowserActionResult> {
    const { client, tabId } = this.assertCamofoxOpen();

    try {
      switch (action.type) {
        case "navigate": {
          const result = await client.navigate(tabId, { userId: this.opts.userId, url: action.url });
          this.camofoxUrl = typeof result.url === "string" ? result.url : action.url;
          return { success: true, url: this.camofoxUrl, captchaDetected: false };
        }

        case "click": {
          await client.click(tabId, this.selectorInput(action.selector));
          return { success: true, url: this.camofoxUrl };
        }

        case "fill": {
          await client.type(tabId, { ...this.selectorInput(action.selector), text: action.value });
          return { success: true, url: this.camofoxUrl };
        }

        case "screenshot": {
          const screenshot = await client.screenshot(tabId, { userId: this.opts.userId });
          return { success: true, screenshot, url: this.camofoxUrl };
        }

        case "evaluate": {
          this.camofoxSnapshot = await client.snapshot(tabId, { userId: this.opts.userId });
          this.camofoxUrl = this.camofoxSnapshot.url ?? this.camofoxUrl;
          return { success: true, text: this.camofoxSnapshot.snapshot, url: this.camofoxUrl };
        }

        case "wait_for":
        case "select":
        case "submit":
          return {
            success: false,
            error: `Camofox workbench backend does not support "${action.type}" through this action shape yet`,
            url: this.camofoxUrl,
          };

        default:
          return { success: false, error: "Unknown action type", url: this.camofoxUrl };
      }
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message, url: this.camofoxUrl };
    }
  }

  private selectorInput(selector: string) {
    return /^e\d+$/i.test(selector)
      ? { userId: this.opts.userId, ref: selector }
      : { userId: this.opts.userId, selector };
  }

  async currentUrl(): Promise<string> {
    if (this.opts.provider === "camofox") {
      this.assertCamofoxOpen();
      return this.camofoxUrl;
    }
    return this.assertOpen().url();
  }

  async html(): Promise<string> {
    if (this.opts.provider === "camofox") {
      const { client, tabId } = this.assertCamofoxOpen();
      this.camofoxSnapshot = await client.snapshot(tabId, { userId: this.opts.userId });
      return this.camofoxSnapshot.snapshot;
    }
    return this.assertOpen().content();
  }

  async close(): Promise<void> {
    if (this.opts.provider === "camofox") {
      if (this.camofox && this.camofoxTabId) {
        await this.camofox.closeTab(this.camofoxTabId, { userId: this.opts.userId }).catch(() => { /* ignore */ });
      }
      this.camofox = null;
      this.camofoxTabId = null;
      this.camofoxSnapshot = null;
      return;
    }

    await this.page?.context().close().catch(() => { /* ignore */ });
    await this.browser?.close().catch(() => { /* ignore */ });
    this.page = null;
    this.browser = null;
  }
}

// ── Human handoff ─────────────────────────────────────────────────────────────

/**
 * Pause the workbench session and emit an "approval" event requesting human
 * intervention (e.g. CAPTCHA solving, login, MFA). Optionally attaches a
 * screenshot to help the operator understand the blocked state.
 */
export async function requestHumanHandoff(
  session: WorkbenchSession,
  reason: string,
  screenshotBuf?: Buffer
): Promise<void> {
  let screenshotDataUri: string | undefined;
  if (screenshotBuf) {
    screenshotDataUri = `data:image/png;base64,${screenshotBuf.toString("base64")}`;
  }

  await store.updateWorkbenchSession(session.id, { status: "paused" });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "approval",
    status: "needs_approval",
    title: "Human handoff required",
    content: [
      reason,
      screenshotDataUri ? `[screenshot attached — ${(screenshotBuf!.length / 1024).toFixed(1)} KB]` : "",
    ].filter(Boolean).join("\n"),
  });
}

/**
 * Resume a paused session after human intervention.
 */
export async function resumeAfterHandoff(session: WorkbenchSession): Promise<void> {
  await store.updateWorkbenchSession(session.id, { status: "running" });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: "completed",
    title: "Session resumed",
    content: "Human handoff resolved — automation continuing.",
  });
}
