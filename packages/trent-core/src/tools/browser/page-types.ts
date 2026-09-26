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
  /** [H5] Makes this the window's active tab; a background tab gets no animation frames to act on. */
  bringToFront?(): Promise<void>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  close(): Promise<void>;
  /** [H5] The tabs already open in this context; read on an attached browser to find an empty one. */
  pages?(): PageLike[];
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
  /** On a launched browser: closes it. On a CDP-connected one: disconnects and closes nothing. */
  close(): Promise<void>;
  /** [H5] On a CDP-connected browser, the first entry is the profile's own (default) context. */
  contexts?(): ContextLike[];
}

/** Produces a launched browser; the real one wraps `playwright-core`, the tests hand in a fake. */
export type BrowserLauncher = () => Promise<BrowserLike>;

/** [H5] Connects to an already-running Chrome's DevTools endpoint; the tests hand in a fake. */
export type BrowserConnector = (cdpUrl: string) => Promise<BrowserLike>;

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

/** What the password floor and an approval preview need to know about one element or the focused one. */
export interface FieldKind {
  readonly tag?: string;
  readonly type?: string;
  readonly autocomplete?: string;
  /** The element's accessible name, clipped; only ever shown to a human on an approval card. */
  readonly label?: string;
}

const FIELD_KIND_BODY =
  "({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || 'text').toLowerCase(), " +
  "autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(), " +
  "label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80) })";

/**
 * `FieldKind` of one element, for the password floor and the preview. A real `Function`, not a
 * string: `locator.evaluate` calls only a function with the element; a string is evaluated as an
 * expression, so `"(el) => ..."` came back as nothing and the password floor saw no field against
 * a real page (found by the attach suite; `browser.chromium.test.ts` now pins it). Built with
 * `new Function` so no transpiler helper can leak into the source Playwright ships to the page.
 */
export const FIELD_KIND_FN = new Function("el", `return ${FIELD_KIND_BODY};`) as (el: Element) => FieldKind;

/** [H5] `FieldKind` of the focused element, or null; a key press there types into it. */
export const FOCUSED_FIELD_SCRIPT = `(() => { const el = document.activeElement; if (!el || el === document.body) return null; return ${FIELD_KIND_BODY}; })()`;

/** Autocomplete tokens that mean the field holds a secret the human types: a password or a one-time code. */
const SECRET_AUTOCOMPLETE = /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/;

/** True for a field Trent never types into: `type=password`, or one the page marks as a password or a one-time code. */
export function isSecretField(kind: FieldKind | null | undefined): boolean {
  if (!kind) return false;
  return kind.type === "password" || SECRET_AUTOCOMPLETE.test(kind.autocomplete ?? "");
}

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
