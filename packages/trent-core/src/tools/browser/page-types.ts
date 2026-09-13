/**
 * The slice of Playwright the session uses, declared structurally so the unit tests drive the
 * adapter with a fake and no Chromium, and so `playwright-core` is imported in exactly one place
 * (`launch.ts`). Every page script is a string evaluated in the page; none of them return page
 * content to a log.
 */

export interface LocatorLike {
  count(): Promise<number>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  evaluate(script: string | ((el: Element) => unknown)): Promise<unknown>;
}

export interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

export interface PageLike {
  goto(url: string, options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<unknown>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate(script: string, arg?: unknown): Promise<unknown>;
  screenshot(options: { path?: string; fullPage?: boolean; type?: "png" }): Promise<Buffer>;
  keyboard: { press(key: string, options?: { delay?: number }): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  locator(selector: string): LocatorLike;
  on(event: "console", handler: (message: ConsoleMessageLike) => void): unknown;
  on(event: "pageerror", handler: (error: Error) => void): unknown;
  on(event: string, handler: (arg: never) => void): unknown;
  isClosed?(): boolean;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  close(): Promise<void>;
}

export interface ContextOptions {
  ignoreHTTPSErrors?: boolean;
  viewport?: { width: number; height: number };
  javaScriptEnabled?: boolean;
  acceptDownloads?: boolean;
  serviceWorkers?: "allow" | "block";
}

export interface BrowserLike {
  newContext(options?: ContextOptions): Promise<ContextLike>;
  close(): Promise<void>;
}

/** Produces a launched browser; the real one wraps `playwright-core`, the tests hand in a fake. */
export type BrowserLauncher = () => Promise<BrowserLike>;

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  type?: string;
  href?: string;
  value?: string;
}

export interface PageImage {
  src: string;
  alt: string;
}

export const REF_ATTRIBUTE = "data-trent-ref";

/** The CSS selector for a snapshot ref such as `@e5`; the `@` is optional on input. */
export function refSelector(ref: string): string {
  const bare = ref.trim().replace(/^@/, "");
  return `[${REF_ATTRIBUTE}="${bare}"]`;
}

const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], ' +
  '[role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"]';

/** Tags every visible interactive element with a ref and returns `SnapshotElement[]`. */
export const SNAPSHOT_SCRIPT = `(() => {
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)}));
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const label = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const target = document.getElementById(labelled);
      if (target) return target.textContent || "";
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
      if (forLabel) return forLabel.textContent || "";
    }
    return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.textContent || el.getAttribute("name") || "";
  };
  const out = [];
  let index = 0;
  for (const el of nodes) {
    if (!visible(el)) continue;
    index += 1;
    const ref = "e" + index;
    el.setAttribute(ATTR, ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? (el.getAttribute("type") || "text") + " input" : tag);
    const entry = { ref: "@" + ref, role, name: label(el).replace(/\\s+/g, " ").trim().slice(0, 120) };
    if (tag === "input") entry.type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "a") entry.href = el.getAttribute("href") || "";
    if ((tag === "input" && entry.type !== "password") || tag === "textarea" || tag === "select") {
      entry.value = String(el.value || "").slice(0, 80);
    }
    out.push(entry);
  }
  return out;
})()`;

/** Visible page text via `innerText`, which respects CSS visibility unlike `textContent`. */
export const TEXT_SCRIPT = "(() => (document.body ? document.body.innerText : \"\"))()";

/** `PageImage[]` for every `<img>` with a resolvable source. */
export const IMAGES_SCRIPT = `(() => {
  const images = Array.from(document.images);
  return images
    .map((img) => ({ src: img.currentSrc || img.src || "", alt: (img.alt || "").slice(0, 120) }))
    .filter((img) => img.src);
})()`;

/** `{ tag, type }` of one element, for the password floor. */
export const FIELD_KIND_SCRIPT = "(el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || 'text').toLowerCase() })";

/** Draws a numbered [N] badge on every ref'd element; N maps to @eN. Idempotent. */
export const ANNOTATE_SCRIPT = `(() => {
  const ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
  document.querySelectorAll("[data-trent-annotation]").forEach((n) => n.remove());
  for (const el of document.querySelectorAll("[" + ATTR + "]")) {
    const rect = el.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.setAttribute("data-trent-annotation", "1");
    badge.textContent = "[" + el.getAttribute(ATTR).slice(1) + "]";
    badge.style.cssText = "position:fixed;z-index:2147483647;background:#111;color:#fff;font:11px monospace;padding:1px 3px;" +
      "border-radius:2px;pointer-events:none;left:" + Math.max(0, rect.left) + "px;top:" + Math.max(0, rect.top - 14) + "px";
    document.body.appendChild(badge);
  }
})()`;

export const UNANNOTATE_SCRIPT = '(() => { document.querySelectorAll("[data-trent-annotation]").forEach((n) => n.remove()); })()';
