/**
 * One browser session per adapter: a browser launched on the first `browser_navigate`, one fresh
 * isolated context carrying the broker token header, one page. Closed by the adapter's `cleanup`
 * (the seat's run end). Every method returns text for the model; nothing here logs page content.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ANNOTATE_SCRIPT,
  FIELD_KIND_SCRIPT,
  IMAGES_SCRIPT,
  refSelector,
  SNAPSHOT_SCRIPT,
  TEXT_SCRIPT,
  UNANNOTATE_SCRIPT,
  type BrowserLauncher,
  type BrowserLike,
  type ContextLike,
  type PageImage,
  type PageLike,
  type SnapshotElement,
} from "./page-types.js";
import { ACTION_TIMEOUT_MS, MAX_CONSOLE_MESSAGES, MAX_IMAGES, NAVIGATION_TIMEOUT_MS, SCROLL_STEP } from "./schemas.js";

export interface SessionOptions {
  readonly launcher: BrowserLauncher;
  /** The opaque broker token, sent as `x-trent-proxy-token` on every request. */
  readonly token: string;
  /** `<profileDir>/browser/<runId>`; created on the first screenshot. */
  readonly screenshotDir: string;
}

export class PasswordFieldError extends Error {
  constructor(ref: string) {
    super(`browser_type refused: ${ref} is a password field. Trent never types secrets; ask the human to enter it.`);
    this.name = "PasswordFieldError";
  }
}

export class NoPageError extends Error {
  constructor() {
    super("No page is open: call browser_navigate first.");
    this.name = "NoPageError";
  }
}

function formatElement(el: SnapshotElement): string {
  const parts = [`[${el.ref}] ${el.role}`];
  if (el.name) parts.push(JSON.stringify(el.name));
  if (el.href) parts.push(`href=${JSON.stringify(el.href.slice(0, 200))}`);
  if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
  return parts.join(" ");
}

export class BrowserSession {
  private browser: BrowserLike | null = null;
  private context: ContextLike | null = null;
  private page: PageLike | null = null;
  private launching: Promise<PageLike> | null = null;
  private readonly consoleLog: string[] = [];
  private shots = 0;

  constructor(private readonly options: SessionOptions) {}

  /** True once a navigation has opened a page. */
  get isOpen(): boolean {
    return this.page !== null && !(this.page.isClosed?.() ?? false);
  }

  private current(): PageLike {
    if (!this.isOpen || !this.page) throw new NoPageError();
    return this.page;
  }

  private async ensurePage(): Promise<PageLike> {
    if (this.isOpen && this.page) return this.page;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.browser = await this.options.launcher();
      this.context = await this.browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      await this.context.setExtraHTTPHeaders({ "x-trent-proxy-token": this.options.token });
      const page = await this.context.newPage();
      page.on("console", (message) => this.pushConsole(`[${message.type()}] ${message.text()}`));
      page.on("pageerror", (error) => this.pushConsole(`[pageerror] ${error.message}`));
      this.page = page;
      return page;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private pushConsole(line: string): void {
    this.consoleLog.push(line.slice(0, 500));
    if (this.consoleLog.length > MAX_CONSOLE_MESSAGES) this.consoleLog.splice(0, this.consoleLog.length - MAX_CONSOLE_MESSAGES);
  }

  /** Loads `url` (already floor-checked by the adapter) and returns the compact snapshot. */
  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage();
    this.consoleLog.length = 0;
    await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    return this.snapshot(false);
  }

  async snapshot(full: boolean): Promise<string> {
    const page = this.current();
    const elements = ((await page.evaluate(SNAPSHOT_SCRIPT)) as SnapshotElement[] | null) ?? [];
    const lines = [`Page: ${await page.title()}`, `URL: ${page.url()}`, "", `${elements.length} interactive element(s):`, ...elements.map(formatElement)];
    if (full) {
      const text = String((await page.evaluate(TEXT_SCRIPT)) ?? "");
      lines.push("", "Page text:", text);
    }
    return lines.join("\n");
  }

  async text(): Promise<string> {
    const page = this.current();
    return String((await page.evaluate(TEXT_SCRIPT)) ?? "");
  }

  async click(ref: string): Promise<string> {
    const page = this.current();
    const locator = page.locator(refSelector(ref));
    if ((await locator.count()) === 0) return `${ref} is not in the current snapshot; call browser_snapshot to refresh refs.`;
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    return `Clicked ${ref}.\n\n${await this.snapshot(false)}`;
  }

  /** Throws `PasswordFieldError` before any text reaches the page. */
  async type(ref: string, text: string): Promise<string> {
    const page = this.current();
    const locator = page.locator(refSelector(ref));
    if ((await locator.count()) === 0) return `${ref} is not in the current snapshot; call browser_snapshot to refresh refs.`;
    const kind = (await locator.evaluate(FIELD_KIND_SCRIPT)) as { tag?: string; type?: string } | null;
    if (kind?.type === "password") throw new PasswordFieldError(ref);
    await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
    return `Typed ${text.length} character(s) into ${ref}.`;
  }

  async scroll(direction: "up" | "down"): Promise<string> {
    const page = this.current();
    await page.mouse.wheel(0, direction === "down" ? SCROLL_STEP : -SCROLL_STEP);
    return `Scrolled ${direction}.`;
  }

  async back(): Promise<string> {
    const page = this.current();
    await page.goBack({ timeout: NAVIGATION_TIMEOUT_MS });
    return this.snapshot(false);
  }

  async press(key: string): Promise<string> {
    const page = this.current();
    await page.keyboard.press(key);
    return `Pressed ${key}.\n\n${await this.snapshot(false)}`;
  }

  async images(): Promise<string> {
    const page = this.current();
    const images = (((await page.evaluate(IMAGES_SCRIPT)) as PageImage[] | null) ?? []).slice(0, MAX_IMAGES);
    if (!images.length) return "No images on the current page.";
    return [`${images.length} image(s):`, ...images.map((img, i) => `${i + 1}. ${img.src}${img.alt ? ` (alt: ${img.alt})` : ""}`)].join("\n");
  }

  async console(clear: boolean, expression?: string): Promise<string> {
    const page = this.current();
    const lines: string[] = [];
    if (expression) {
      const value = await page.evaluate(expression);
      lines.push(`Result: ${value === undefined ? "undefined" : JSON.stringify(value)}`);
    }
    lines.push(this.consoleLog.length ? `${this.consoleLog.length} console message(s):\n${this.consoleLog.join("\n")}` : "No console messages since navigation.");
    if (clear) this.consoleLog.length = 0;
    return lines.join("\n\n");
  }

  /** Writes `<screenshotDir>/<n>-<ts>.png` and returns the path. */
  async screenshot(fullPage: boolean, annotate = false): Promise<string> {
    const page = this.current();
    mkdirSync(this.options.screenshotDir, { recursive: true });
    this.shots += 1;
    const file = path.join(this.options.screenshotDir, `${String(this.shots).padStart(3, "0")}-${Date.now()}.png`);
    if (annotate) await page.evaluate(ANNOTATE_SCRIPT);
    try {
      await page.screenshot({ path: file, fullPage, type: "png" });
    } finally {
      if (annotate) await page.evaluate(UNANNOTATE_SCRIPT);
    }
    return file;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    this.page = null;
    this.context = null;
    this.browser = null;
    try {
      await context?.close();
    } catch {
      // Already gone.
    }
    try {
      await browser?.close();
    } catch {
      // Already gone.
    }
  }
}
