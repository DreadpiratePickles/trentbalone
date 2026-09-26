/**
 * One browser session per page source: the page is obtained on the first `browser_navigate` and
 * released by the adapter's `cleanup` (the seat's run end). Two sources exist: the launched one
 * here (a browser launched for this run, one fresh isolated context carrying the broker token
 * header, one page) and [H5] the attached one in `attach.ts` (the owner's own Chrome over CDP,
 * whose release disconnects and closes nothing). Every method returns text for the model; nothing
 * here logs page content.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ANNOTATE_SCRIPT,
  FIELD_KIND_FN,
  FOCUSED_FIELD_SCRIPT,
  IMAGES_SCRIPT,
  isSecretField,
  refSelector,
  SNAPSHOT_SCRIPT,
  TEXT_SCRIPT,
  UNANNOTATE_SCRIPT,
  type BrowserLauncher,
  type BrowserLike,
  type ContextLike,
  type FieldKind,
  type PageImage,
  type PageLike,
  type SnapshotElement,
} from "./page-types.js";
import { ACTION_TIMEOUT_MS, MAX_CONSOLE_MESSAGES, MAX_IMAGES, NAVIGATION_TIMEOUT_MS, SCROLL_STEP } from "./schemas.js";

const TRANSIENT_RETRY_DELAY_MS = 250;
/** Chromium net errors that mean "the network moved under us", not "this page is bad". */
const TRANSIENT_NET_ERRORS = ["net::ERR_NETWORK_CHANGED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_ABORTED"];

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_NET_ERRORS.some((code) => message.includes(code));
}

/** Where a session's page comes from, and how it is let go. */
export interface PageSource {
  /** The page the session drives, obtained for the first navigation, whose target is `url`. */
  open(url: string): Promise<PageLike>;
  /** Releases what `open` obtained. Safe to call twice, and before `open`. */
  close(): Promise<void>;
}

/** The launched source: a browser started for this run, reachable to the network only through the proxy. */
export function launchedSource(launcher: BrowserLauncher, token: string): PageSource {
  let browser: BrowserLike | null = null;
  let context: ContextLike | null = null;
  return {
    async open() {
      browser = await launcher();
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      await context.setExtraHTTPHeaders({ "x-trent-proxy-token": token });
      return context.newPage();
    },
    async close() {
      const [ownContext, ownBrowser] = [context, browser];
      context = null;
      browser = null;
      try {
        await ownContext?.close();
      } catch {
        // Already gone.
      }
      try {
        await ownBrowser?.close();
      } catch {
        // Already gone.
      }
    },
  };
}

export interface SessionOptions {
  readonly source: PageSource;
  /** `<profileDir>/browser/<runId>`; created on the first screenshot. */
  readonly screenshotDir: string;
}

export class PasswordFieldError extends Error {
  constructor(subject: string, tool = "browser_type") {
    super(`${tool} refused: ${subject} is a password field. Trent never types secrets; ask the human to enter it.`);
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
  private page: PageLike | null = null;
  private launching: Promise<PageLike> | null = null;
  private readonly consoleLog: string[] = [];
  private shots = 0;

  constructor(private readonly options: SessionOptions) {}

  /** True once a navigation has opened a page. */
  get isOpen(): boolean {
    return this.page !== null && !(this.page.isClosed?.() ?? false);
  }

  /** The URL the page shows now; empty before the first navigation. */
  get currentUrl(): string {
    return this.isOpen && this.page ? this.page.url() : "";
  }

  /** [H5] Brings the page to the front of its window, where the owner can watch what happens to it. */
  async bringToFront(): Promise<void> {
    if (this.isOpen && this.page) await this.page.bringToFront?.();
  }

  private current(): PageLike {
    if (!this.isOpen || !this.page) throw new NoPageError();
    return this.page;
  }

  private async ensurePage(url: string): Promise<PageLike> {
    if (this.isOpen && this.page) return this.page;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const page = await this.options.source.open(url);
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

  /**
   * Loads `url` (already floor-checked by the adapter) and returns the compact snapshot. One
   * transient network error from Chromium (the network interface changed, the connection was
   * reset or closed under the request) is retried once after a short pause; a second failure, or
   * any other error, is the caller's. CI saw `net::ERR_NETWORK_CHANGED` on a shared runner twice.
   */
  async navigate(url: string): Promise<string> {
    const page = await this.ensurePage(url);
    this.consoleLog.length = 0;
    try {
      await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    }
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

  /** What the floors and a preview know about `ref`, or null when it is not in the current snapshot. */
  async element(ref: string): Promise<FieldKind | null> {
    const locator = this.current().locator(refSelector(ref));
    if ((await locator.count()) === 0) return null;
    return ((await locator.evaluate(FIELD_KIND_FN)) as FieldKind | null) ?? {};
  }

  /** [H5] Throws `PasswordFieldError` when focus is in a secret field, where a key press would type. */
  async assertFocusNotSecret(tool: string): Promise<void> {
    const focused = (await this.current().evaluate(FOCUSED_FIELD_SCRIPT)) as FieldKind | null;
    if (isSecretField(focused)) throw new PasswordFieldError("the focused element", tool);
  }

  /** Throws `PasswordFieldError` before any text reaches the page. */
  async type(ref: string, text: string): Promise<string> {
    const page = this.current();
    const locator = page.locator(refSelector(ref));
    if ((await locator.count()) === 0) return `${ref} is not in the current snapshot; call browser_snapshot to refresh refs.`;
    const kind = (await locator.evaluate(FIELD_KIND_FN)) as FieldKind | null;
    if (isSecretField(kind)) throw new PasswordFieldError(ref);
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
    await this.assertFocusNotSecret("browser_press");
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
    this.page = null;
    await this.options.source.close();
  }
}
