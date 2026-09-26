/**
 * The `browser` toolset: Hermes's `browser_*` tools on a headless Chromium driven by
 * `playwright-core`, reachable to the network only through Trent's egress proxy.
 *
 * Floors, applied inside `execute` so an approval can never lift them:
 *  - `browser_navigate` runs the same SSRF check as `web` (scheme, secret-shaped query, private,
 *    loopback, link-local and cloud-metadata addresses, DNS included) before the browser exists;
 *  - `browser_type` into a password field is refused before any text reaches the page;
 *  - the proxy's allowlist is the second gate: a host outside `intercept_domains` is refused at
 *    CONNECT and the seat sees the navigation error.
 * Screenshots are files under `<profileDir>/browser/<runId>/`; the tool output carries the path,
 * never the bytes. Text output is capped by the spillover rule.
 *
 * [H5] `browser_navigate {"attach": true}` switches the run to the owner's own running Chrome
 * (`attach.ts`, off unless `tools.browser.attach.enabled`); every tool then acts on that tab, with
 * the proxy's allowlist applied by the adapter and every action bound to an approval.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions } from "../web/schemas.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";
import type { BoundApprovalStore } from "../../governance/bound-approvals.js";
import { ATTACH_GATED_TOOLS, AttachedMode } from "./attach.js";
import type { BrowserAttachConfig } from "./attach-config.js";
import { CHROMIUM_INSTALL_HINT, findChromium } from "./chromium.js";
import { createCdpConnector, createChromiumLauncher } from "./launch.js";
import type { BrowserConnector, BrowserLauncher } from "./page-types.js";
import { BROWSER_TOOL_SCHEMAS, SNAPSHOT_LIMIT } from "./schemas.js";
import { BrowserSession, launchedSource, NoPageError, PasswordFieldError } from "./session.js";

export { BROWSER_TOOL_SCHEMAS, SNAPSHOT_LIMIT } from "./schemas.js";
export { findChromium, CHROMIUM_INSTALL_HINT } from "./chromium.js";
export type { BrowserConnector, BrowserLauncher, BrowserLike, ContextLike, PageLike } from "./page-types.js";
// [H5] browser attach
export { ATTACH_GATED_TOOLS, attachedSiteRefusal, siteOf } from "./attach.js";
export { browserAttachOptions, BrowserAttachConfigSchema, BrowserToolsConfigSchema, checkCdpUrl, DEFAULT_CDP_URL, type BrowserAttachConfig, type BrowserAttachConfigSource } from "./attach-config.js";
export { appendAttachAudit, attachAuditPath, readAttachAudit, verifyAttachAudit, ATTACH_AUDIT_FILE } from "./attach-audit.js";

export const BROWSER_ADAPTER_NAME = "browser";

/** Screenshot + question -> the model's answer. Bound to the vision toolset by the builder. */
export type VisionAsk = (input: { image: Buffer; mimeType: string; question: string }) => Promise<string>;

export interface BrowserAdapterOptions {
  readonly profileDir: string;
  /** Screenshots land in `<profileDir>/browser/<runId>/`. Defaults to a timestamp. */
  readonly runId?: string;
  readonly egress: { readonly proxyUrl: string; readonly token: string; readonly caPem: string };
  /** Test seam: a fake browser. When absent, Chromium is launched through `playwright-core`. */
  readonly launcher?: BrowserLauncher;
  /** `undefined` searches the machine; `null` means "none" (the not_available path). */
  readonly executablePath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly lookup?: LookupFn;
  readonly vision?: VisionAsk;
  // [H5] browser attach
  /** `tools.browser.attach`. Absent or `enabled: false`: `attach: true` is refused and nothing connects. */
  readonly attach?: BrowserAttachConfig;
  /** `egress.intercept_domains`: the allowlist an attached browser is held to. Absent allows nothing. */
  readonly allowedHosts?: readonly string[];
  /** Test seam: a fake CDP connection. When absent, `playwright-core`'s `connectOverCDP`. */
  readonly connector?: BrowserConnector;
  /** Where attached actions bind their approvals; defaults to the process's installed store. */
  readonly bindings?: BoundApprovalStore;
  /** The seat acting, named on the approval row and the attach audit. */
  readonly seat?: string;
}

type BrowserMode = "launched" | "attached";

const SPECS: readonly ToolSpec[] = [
  { name: "browser_navigate", primary: "url", signature: ["url"] },
  { name: "browser_snapshot", primary: "full", signature: ["full"] },
  { name: "browser_click", primary: "ref", signature: ["ref"] },
  { name: "browser_type", primary: "text", signature: ["ref", "text"] },
  { name: "browser_scroll", primary: "direction", signature: ["direction"] },
  { name: "browser_back", primary: "_", signature: ["back"] },
  { name: "browser_press", primary: "key", signature: ["key"] },
  { name: "browser_get_images", primary: "_", signature: ["images"] },
  { name: "browser_vision", primary: "question", signature: ["question"] },
  { name: "browser_console", primary: "expression", signature: ["expression"] },
  { name: "browser_screenshot", primary: "full_page", signature: ["full_page"] },
  { name: "browser_get_text", primary: "_", signature: ["text_only"] },
];

const ROUTING_TEXT =
  "browser open a web page, click a button or link, fill in a form, type into a field, scroll, press a key, " +
  "take a screenshot, look at a page visually, read the page text, check the javascript console, interact with a website";

export function createBrowserAdapter(options: BrowserAdapterOptions): TrentToolAdapter {
  const executable = options.launcher ? "injected" : options.executablePath === undefined ? findChromium(options.env ?? process.env) : options.executablePath;
  const launcher: BrowserLauncher | null =
    options.launcher ?? (executable ? createChromiumLauncher({ executablePath: executable, proxyUrl: options.egress.proxyUrl, caPem: options.egress.caPem }) : null);
  const runId = options.runId ?? `run-${Date.now()}`;
  const screenshotDir = path.join(options.profileDir, "browser", runId);
  const session = launcher ? new BrowserSession({ source: launchedSource(launcher, options.egress.token), screenshotDir }) : null;
  const attached = new AttachedMode({
    adapterName: BROWSER_ADAPTER_NAME,
    allowedHosts: options.allowedHosts ?? [],
    connector: options.connector ?? createCdpConnector(),
    profileDir: options.profileDir,
    screenshotDir,
    ...(options.attach ? { config: options.attach } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.bindings ? { bindings: options.bindings } : {}),
    ...(options.seat === undefined ? {} : { seat: options.seat }),
  });
  let mode: BrowserMode = "launched";
  /** `attach` on a navigation picks the browser; any other call uses the one the run is on. */
  const modeFor = (tool: string, args: Record<string, unknown>): BrowserMode =>
    tool === "browser_navigate" && args.attach === true ? "attached" : tool === "browser_navigate" && args.attach === false ? "launched" : mode;
  const available = session !== null || attached.enabled;

  const done = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    record(BROWSER_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "browser", SNAPSHOT_LIMIT));
  const fail = (action: string, summary: string): ToolCallRecord => record(BROWSER_ADAPTER_NAME, action, "failed", summary);

  async function navigate(action: string, args: Record<string, unknown>, live: BrowserSession): Promise<ToolCallRecord> {
    const url = stringArg(args, "url")?.trim();
    if (!url) return fail(action, 'browser_navigate requires a non-empty "url".');
    const verdict = await checkUrlSafety(url, { lookup: options.lookup });
    if (!verdict.ok) return record(BROWSER_ADAPTER_NAME, action, "blocked", `browser_navigate refused ${url}: ${verdict.reason}`);
    return done(action, "completed", await live.navigate(verdict.url.toString()));
  }

  async function vision(action: string, args: Record<string, unknown>, live: BrowserSession): Promise<ToolCallRecord> {
    const question = stringArg(args, "question")?.trim();
    if (!question) return fail(action, 'browser_vision requires a non-empty "question".');
    if (!options.vision) return fail(action, "browser_vision not_available: no vision model is bound to this seat. Use browser_screenshot and read the page text instead.");
    const file = await live.screenshot(false, args.annotate === true);
    const answer = await options.vision({ image: readFileSync(file), mimeType: "image/png", question });
    return done(action, "completed", `${answer}\n\nscreenshot_path: ${file}`);
  }

  async function launchedCall(action: string, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    if (!session) return fail(action, `${tool} not_available: ${CHROMIUM_INSTALL_HINT}`);
    if (tool !== "browser_navigate" && !session.isOpen) return fail(action, `${tool} needs an open page: call browser_navigate first.`);
    return run(action, tool, args, session);
  }

  async function run(action: string, tool: string, args: Record<string, unknown>, live: BrowserSession): Promise<ToolCallRecord> {
    switch (tool) {
      case "browser_navigate":
        return navigate(action, args, live);
      case "browser_snapshot":
        return done(action, "completed", await live.snapshot(args.full === true));
      case "browser_click": {
        const ref = stringArg(args, "ref")?.trim();
        if (!ref) return fail(action, 'browser_click requires "ref" (e.g. "@e5").');
        return done(action, "completed", await live.click(ref));
      }
      case "browser_type": {
        const ref = stringArg(args, "ref")?.trim();
        const text = stringArg(args, "text");
        if (!ref || text === undefined) return fail(action, 'browser_type requires "ref" and "text".');
        return done(action, "completed", await live.type(ref, text));
      }
      case "browser_scroll": {
        const direction = stringArg(args, "direction");
        if (direction !== "up" && direction !== "down") return fail(action, 'browser_scroll requires "direction": "up" or "down".');
        return done(action, "completed", await live.scroll(direction));
      }
      case "browser_back":
        return done(action, "completed", await live.back());
      case "browser_press": {
        const key = stringArg(args, "key")?.trim();
        if (!key) return fail(action, 'browser_press requires "key" (e.g. "Enter").');
        return done(action, "completed", await live.press(key));
      }
      case "browser_get_images":
        return done(action, "completed", await live.images());
      case "browser_vision":
        return vision(action, args, live);
      case "browser_console":
        return done(action, "completed", await live.console(args.clear === true, stringArg(args, "expression")));
      case "browser_screenshot":
        return done(action, "completed", `Screenshot saved: ${await live.screenshot(args.full_page === true)}`);
      case "browser_get_text":
        return done(action, "completed", await live.text());
      default:
        return fail(action, `Unknown browser tool "${tool}".`);
    }
  }

  return {
    name: BROWSER_ADAPTER_NAME,
    scopes: [BROWSER_ADAPTER_NAME, ...BROWSER_TOOL_SCHEMAS.map((s) => s.name)],
    availability: available ? "real" : "unavailable",
    instructions: renderToolInstructions(BROWSER_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => (available ? "connected" : "needs_credentials"),
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, args, error } = parseAction(action, SPECS);
      return !error && attached.enabled && modeFor(tool, args) === "attached" && ATTACH_GATED_TOOLS.has(tool);
    },
    async execute(action) {
      const { tool, args, error } = parseAction(action, SPECS);
      if (error) return fail(action, error);
      const want = modeFor(tool, args);
      try {
        const result =
          want === "attached"
            ? await attached.execute(action, tool, args, (name, input, live) => run(action, name, input, live))
            : await launchedCall(action, tool, args);
        if (tool === "browser_navigate" && result.status === "completed") mode = want;
        return result;
      } catch (err) {
        if (err instanceof PasswordFieldError) return record(BROWSER_ADAPTER_NAME, action, "blocked", err.message);
        if (err instanceof NoPageError) return fail(action, err.message);
        const message = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
        return fail(action, `${tool} failed: ${message}`);
      }
    },
    async dryRun(action) {
      const { tool, args, error } = parseAction(action, SPECS);
      if (!error && modeFor(tool, args) === "attached") {
        try {
          return await attached.dryRun(action, tool, args);
        } catch (err) {
          return fail(action, `${tool} failed: ${err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err)}`);
        }
      }
      return record(BROWSER_ADAPTER_NAME, action, "mocked", `browser dry-run: would perform "${action}" in the headless browser.`);
    },
    async cleanup() {
      await session?.close();
      // Detaching disconnects from the owner's Chrome; it closes none of the owner's tabs.
      await attached.detach();
    },
  };
}
