/**
 * [H5] Attach mode: the `browser` toolset acting in the owner's OWN running Chrome, over the
 * DevTools protocol, so a seat can work in accounts the owner is already signed in to
 * (docs/browser.md, "Attach to your own Chrome"). Chosen per navigation with `attach: true` on
 * `browser_navigate`; every other `browser_*` tool then acts on the attached tab.
 *
 * The attached browser is the owner's network: it never passes the egress proxy, and no broker
 * token header is ever set on it (that would hand the token to every site the owner visits). What
 * the proxy would have enforced is enforced here instead, in this order, before any approval is
 * asked for and whatever an approval says:
 *   1. `tools.browser.attach.enabled`, and a `cdp_url` on this machine;
 *   2. a navigation passes the SSRF floor (`checkUrlSafety`) and `egress.intercept_domains`, the
 *      proxy's own allowlist function; every later call re-checks the tab's CURRENT site, since a
 *      click can leave the list;
 *   3. no typing into a password or one-time-code field, no key press while one has focus, and no
 *      JavaScript evaluation (it would read the logged-in page's cookies and tokens).
 * Then every call that changes the tab (navigate, back, click, type, press, scroll) is a
 * `customer_facing` call bound to an approval (`governance/bound-approvals.ts`) whose key carries
 * the site, the element and an occurrence counter, so one yes runs exactly one call on exactly
 * that page. Reads (snapshot, text, screenshot, images, vision, console) are not asked about.
 * Each action is recorded with its site in `attach-audit.ts`. Detaching disconnects and closes
 * no tab: a tab showing the owner's content is never navigated either; an empty one is reused,
 * else a new one is opened, and it is brought to the front before every approved action, so the
 * owner watches it happen (a background tab also gets no animation frames, and a click waits on
 * those).
 */
import crypto from "node:crypto";
import { isHostAllowed } from "../../egress/CredentialBroker.js";
import { currentBoundApprovals, requireBoundApproval, type BoundApprovalStore, type BoundCall } from "../../governance/bound-approvals.js";
import type { PolicyClass } from "../../governance/policy-rules.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { record, stringArg } from "../action.js";
import type { ToolCallRecord } from "../types.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";
import { appendAttachAudit } from "./attach-audit.js";
import { checkCdpUrl, DEFAULT_CDP_URL, type BrowserAttachConfig } from "./attach-config.js";
import { isSecretField, type BrowserConnector, type BrowserLike, type FieldKind } from "./page-types.js";
import { BrowserSession, PasswordFieldError, type PageSource } from "./session.js";

/** The tools that change the attached tab; each waits for an approval bound to exactly it. */
export const ATTACH_GATED_TOOLS: ReadonlySet<string> = new Set(["browser_navigate", "browser_back", "browser_click", "browser_type", "browser_press", "browser_scroll"]);
export const ATTACH_CLASSES: readonly PolicyClass[] = ["customer_facing"];
/** Tabs that show nothing of the owner's, so one may be taken over. */
const EMPTY_TABS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/", "brave://newtab/"]);

export class AttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachError";
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/** Origin + path of an http(s) URL (never the query or fragment); anything else without its query. */
export function siteOf(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`;
  } catch {
    // Not a URL: shown as written, minus anything after ? or #.
  }
  return raw.split(/[?#]/)[0] ?? raw;
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

/** Null when `raw` is an http(s) page on an allowlisted host; else why an attached session may not touch it. */
export function attachedSiteRefusal(raw: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a web page`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${siteOf(raw)} is not an http(s) page`;
  if (!isHostAllowed(url.hostname, allowedHosts)) {
    return `host "${url.hostname}" is not in egress.intercept_domains, the allowlist an attached browser is held to (it does not pass the egress proxy, so Trent applies the list itself)`;
  }
  return null;
}

export interface AttachedModeOptions {
  readonly adapterName: string;
  readonly config?: BrowserAttachConfig;
  /** `egress.intercept_domains`. Empty allows nothing: deny by default. */
  readonly allowedHosts: readonly string[];
  readonly connector: BrowserConnector;
  readonly profileDir: string;
  readonly screenshotDir: string;
  readonly lookup?: LookupFn;
  /** Where approvals bind; defaults to the store `buildTrentTools` installed for this process. */
  readonly bindings?: BoundApprovalStore;
  readonly seat?: string;
}

/** Runs one tool body against the attached session once the floors and the gate let it through. */
export type RunTool = (tool: string, args: Record<string, unknown>, live: BrowserSession) => Promise<ToolCallRecord>;

type Prepared =
  | { readonly record: ToolCallRecord }
  | { readonly gated: false; readonly site: string }
  | { readonly gated: true; readonly site: string; readonly call: BoundCall; readonly preview: string; readonly signature: string };

export class AttachedMode {
  readonly session: BrowserSession;
  readonly sessionId = `attach_${crypto.randomBytes(4).toString("hex")}`;
  private readonly cdp: ReturnType<typeof checkCdpUrl>;
  /** How many times each exact call has run on its approval; the next one needs a new approval. */
  private readonly spent = new Map<string, number>();
  private browser: BrowserLike | null = null;

  constructor(private readonly options: AttachedModeOptions) {
    this.cdp = checkCdpUrl(options.config?.cdp_url ?? DEFAULT_CDP_URL);
    this.session = new BrowserSession({ source: this.source(), screenshotDir: options.screenshotDir });
  }

  get enabled(): boolean {
    return this.options.config?.enabled === true;
  }

  private get actor(): string {
    return this.options.seat ?? "trent";
  }

  private where(): string {
    const hint = this.options.config?.profile_hint;
    return `in your own Chrome${hint ? ` (profile: ${hint})` : ""}, signed in as you`;
  }

  private blocked(action: string, summary: string): { record: ToolCallRecord } {
    return { record: record(this.options.adapterName, action, "blocked", summary) };
  }

  private source(): PageSource {
    return {
      open: async () => {
        if (!this.cdp.ok) throw new AttachError(this.cdp.reason);
        const cdpUrl = this.cdp.url;
        let browser: BrowserLike;
        try {
          browser = await this.options.connector(cdpUrl);
        } catch (error) {
          throw new AttachError(
            `could not attach to Chrome at ${cdpUrl} (${firstLine(error)}). Start Chrome with --remote-debugging-port=9222 and its own --user-data-dir (docs/browser.md, "Attach to your own Chrome").`,
          );
        }
        const context = browser.contexts?.()[0];
        if (!context) {
          await browser.close().catch(() => undefined);
          throw new AttachError(`the Chrome at ${cdpUrl} exposes no profile context to attach to.`);
        }
        const empty = (context.pages?.() ?? []).find((page) => !(page.isClosed?.() ?? false) && EMPTY_TABS.has(page.url()));
        const page = empty ?? (await context.newPage());
        await page.bringToFront?.();
        this.browser = browser;
        this.audit("browser.attach", "browser_session", this.sessionId, `attached to the owner's Chrome at ${cdpUrl} ${this.where()}; ${empty ? "took an empty tab" : "opened a new tab"}; the egress proxy is not in this path`);
        return page;
      },
      close: async () => {
        const browser = this.browser;
        if (!browser) return;
        this.browser = null;
        try {
          // A CDP-connected browser's close() disconnects; no page or context is closed here.
          await browser.close();
        } catch {
          // Already disconnected.
        }
        this.audit("browser.detach", "browser_session", this.sessionId, "detached; no tab or window of the owner's was closed");
      },
    };
  }

  private audit(action: string, objectType: "browser_site" | "browser_session", objectId: string, summary: string): void {
    appendAttachAudit(this.options.profileDir, { actor: this.actor, action, objectType, objectId, summary });
  }

  /** Why nothing may be attached at all, before anything is touched; null when attaching is allowed. */
  refusal(action: string, tool: string): ToolCallRecord | null {
    if (!this.enabled) {
      return record(
        this.options.adapterName,
        action,
        "blocked",
        `${tool} attach refused: tools.browser.attach.enabled is false. Acting in the owner's own Chrome is off until the owner turns it on in config.yaml (docs/browser.md, "Attach to your own Chrome").`,
      );
    }
    if (!this.cdp.ok) return record(this.options.adapterName, action, "blocked", `${tool} attach refused: ${this.cdp.reason}.`);
    return null;
  }

  /** The floors, then the bound call a gated tool needs. Nothing here changes the tab. */
  private async prepare(action: string, tool: string, args: Record<string, unknown>): Promise<Prepared> {
    const name = this.options.adapterName;
    if (tool === "browser_navigate") {
      const url = stringArg(args, "url")?.trim();
      if (!url) return { record: record(name, action, "failed", 'browser_navigate requires a non-empty "url".') };
      const verdict = await checkUrlSafety(url, { lookup: this.options.lookup });
      if (!verdict.ok) return this.blocked(action, `browser_navigate refused ${url}: ${verdict.reason}`);
      const off = attachedSiteRefusal(verdict.url.toString(), this.options.allowedHosts);
      if (off) return this.blocked(action, `browser_navigate refused ${url}: ${off}.`);
      return this.bound(action, tool, args, siteOf(verdict.url.toString()), `open ${verdict.url.toString()} ${this.where()}`);
    }
    if (!this.session.isOpen) return { record: record(name, action, "failed", `${tool} needs an open page: call browser_navigate with "attach": true first.`) };
    const current = this.session.currentUrl;
    const site = siteOf(current);
    const off = attachedSiteRefusal(current, this.options.allowedHosts);
    if (off) return this.blocked(action, `${tool} refused: the attached tab is now on ${site}, and ${off}. Navigate to an allowed site first.`);
    if (tool === "browser_console" && stringArg(args, "expression")) {
      return this.blocked(action, 'browser_console refused: evaluating JavaScript in the owner\'s logged-in page could read its cookies and session tokens. Read the console without "expression", or use browser_snapshot / browser_get_text.');
    }
    if (!ATTACH_GATED_TOOLS.has(tool)) return { gated: false, site };
    return this.gatedAction(action, tool, args, site);
  }

  private async gatedAction(action: string, tool: string, args: Record<string, unknown>, site: string): Promise<Prepared> {
    const ref = stringArg(args, "ref")?.trim();
    if (tool === "browser_back") return this.bound(action, tool, args, site, `go back from ${site} ${this.where()}`);
    if (tool === "browser_scroll") {
      const direction = stringArg(args, "direction");
      // An invalid direction is refused by the tool body before the page is touched.
      if (direction !== "up" && direction !== "down") return { gated: false, site };
      return this.bound(action, tool, args, site, `scroll ${direction} on ${site} ${this.where()}`);
    }
    if (tool === "browser_press") {
      const key = stringArg(args, "key")?.trim();
      if (!key) return { gated: false, site };
      try {
        await this.session.assertFocusNotSecret(tool);
      } catch (error) {
        if (error instanceof PasswordFieldError) return this.blocked(action, error.message);
        throw error;
      }
      return this.bound(action, tool, args, site, `press ${key} on ${site} ${this.where()}`);
    }
    const text = stringArg(args, "text");
    if (!ref || (tool === "browser_type" && text === undefined)) return { gated: false, site };
    const kind = await this.session.element(ref);
    if (kind === null) return { record: record(this.options.adapterName, action, "completed", `${ref} is not in the current snapshot; call browser_snapshot to refresh refs.`) };
    if (tool === "browser_type" && isSecretField(kind)) return this.blocked(action, new PasswordFieldError(ref).message);
    const element = describeElement(kind);
    const verb = tool === "browser_type" ? `type ${JSON.stringify(text)} into ${ref} ${element}` : `click ${ref} ${element}`;
    return this.bound(action, tool, args, site, `${verb} on ${site} ${this.where()}`, element);
  }

  /** The approval key: the call's own arguments, the site, the element, this session and the occurrence. */
  private bound(action: string, tool: string, args: Record<string, unknown>, site: string, preview: string, element?: string): Prepared {
    const signature = JSON.stringify({ tool, args, site, element: element ?? null });
    const context = currentToolCallContext();
    const call: BoundCall = {
      adapter: this.options.adapterName,
      action,
      tool,
      args: { ...args, site, ...(element === undefined ? {} : { element }), attach_session: this.sessionId, occurrence: this.spent.get(signature) ?? 0 },
      classes: ATTACH_CLASSES,
      ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      ...(this.options.seat === undefined ? {} : { seat: this.options.seat }),
    };
    return { gated: true, site, call, preview, signature };
  }

  /** The one path an attached call takes: floors, the bound gate, the tool body, the audit row. */
  async execute(action: string, tool: string, args: Record<string, unknown>, run: RunTool): Promise<ToolCallRecord> {
    const refused = this.refusal(action, tool);
    if (refused) return refused;
    const prepared = await this.prepare(action, tool, args);
    if ("record" in prepared) return prepared.record;
    if (!prepared.gated) return run(tool, args, this.session);
    const decision = requireBoundApproval(prepared.call, prepared.preview, this.options.bindings);
    if (!decision.granted) return decision.record;
    // Spent before it runs: a call that fails half-way has still used its one yes.
    this.spent.set(prepared.signature, (this.spent.get(prepared.signature) ?? 0) + 1);
    let status = "failed";
    try {
      // The owner may have switched tabs since; an approved action happens where they can see it.
      await this.session.bringToFront();
      const result = await run(tool, args, this.session);
      status = result.status;
      return result;
    } finally {
      this.audit(`browser.${tool.replace(/^browser_/, "")}`, "browser_site", originOf(prepared.site), `${tool} on ${prepared.site} ${this.where()}, approved as ${decision.row.id}: ${status}`);
    }
  }

  /** The pause a seat's step shows: the row is stamped so the step's yes grants the replay. */
  async dryRun(action: string, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const refused = this.refusal(action, tool);
    if (refused) return refused;
    const prepared = await this.prepare(action, tool, args);
    if ("record" in prepared) return prepared.record;
    if (!prepared.gated) return record(this.options.adapterName, action, "mocked", `browser dry-run: ${tool} is a read of the attached tab and needs no approval.`);
    (this.options.bindings ?? currentBoundApprovals())?.preview(prepared.call, prepared.preview);
    return record(this.options.adapterName, action, "needs_approval", `${tool} would ${prepared.preview}; it runs once a human approves exactly this call.`);
  }

  async detach(): Promise<void> {
    await this.session.close();
  }
}

function describeElement(kind: FieldKind): string {
  const label = kind.label?.trim();
  return `(${kind.tag || "element"}${label ? ` ${JSON.stringify(label)}` : ""})`;
}
