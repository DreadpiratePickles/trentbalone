import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchExecResult,
  PreviewInspectDiagnostics,
  WorkbenchPreviewInspection,
  WorkbenchScreenshotResult,
} from "@/lib/workbench-provider";
import { checkCommand, requiresApproval } from "@/lib/workbench-safety";
import { captureScreenshot } from "@/lib/workbench-screenshot";
import { SteelBrowserClient, getSteelConfig } from "@/lib/steel-browser";

export type { PreviewInspectDiagnostics };

export type PreviewInspectOptions = {
  trafficAccessToken?: string;
  hydrationTimeoutMs?: number;
  expectedTexts?: string[];
  /** When true (default), SPA shell fetch cannot satisfy inspect — browser must hydrate. */
  strictBrowserOnly?: boolean;
  screenshotCapture?: {
    storageKey: string;
    sessionId: string;
    width?: number;
    height?: number;
  };
};

const HYDRATION_SELECTORS = "button,a,input,textarea,select,[role='button'],main,h1,h2,h3,p";
const DEFAULT_HYDRATION_TIMEOUT_MS = 90_000;

export function backgroundPreviewCommand(command: string, sessionId: string) {
  return `sh -lc ${shellQuote(`nohup ${command} > /tmp/trent-preview-${sessionId}.log 2>&1 &`)}`;
}

export const DEFAULT_PREVIEW_PORT = 3000;

export function parsePortFromCommand(command: string): number | undefined {
  const flag = command.match(/(?:--port[ =]|(?:^|\s)-p\s+)(\d{2,5})/);
  if (flag?.[1]) return Number(flag[1]);
  const envPrefix = command.match(/(?:^|\s)PORT=(\d{2,5})/);
  if (envPrefix?.[1]) return Number(envPrefix[1]);
  return undefined;
}

export async function blockedPreviewCommand(
  session: WorkbenchSession,
  command: string,
  start: number,
): Promise<WorkbenchExecResult | undefined> {
  if (requiresApproval(command)) {
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: "needs_approval",
      title: "Approval required",
      content: `Command requires approval before execution: \`${command}\``,
      command,
    });
    return {
      stdout: "",
      stderr: "Approval required before executing this command.",
      exitCode: 1,
      durationMs: Date.now() - start,
      blocked: true,
      blockedReason: "external_write_requires_approval",
    };
  }

  const safety = checkCommand(command);
  if (!safety.blocked) return undefined;

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "shell",
    status: "failed",
    title: "Command blocked",
    content: safety.reason ?? "Command is not allowed.",
    command,
  });
  return {
    stdout: "",
    stderr: safety.reason ?? "Command blocked by safety policy.",
    exitCode: 126,
    durationMs: Date.now() - start,
    blocked: true,
    blockedReason: safety.reason,
  };
}

export async function inspectHttpPreview(
  url: string,
  screenshotOrOpts: WorkbenchScreenshotResult | PreviewInspectOptions,
  legacyOpts?: PreviewInspectOptions,
): Promise<WorkbenchPreviewInspection> {
  const opts = isScreenshotResult(screenshotOrOpts)
    ? { ...legacyOpts, screenshot: screenshotOrOpts }
    : { ...screenshotOrOpts };
  const {
    trafficAccessToken,
    hydrationTimeoutMs = DEFAULT_HYDRATION_TIMEOUT_MS,
    expectedTexts = [],
    strictBrowserOnly = true,
    screenshotCapture,
  } = opts;
  const placeholderScreenshot = "screenshot" in opts ? opts.screenshot : emptyScreenshot();

  const readyStarted = Date.now();
  const diagnostics: PreviewInspectDiagnostics = {
    proxyAuthUsed: Boolean(trafficAccessToken),
    domProbeSource: "none",
  };

  await waitForPreviewHttp(url, { deadlineMs: hydrationTimeoutMs }, trafficAccessToken);

  const browserProbe = await probeBrowserPreviewDom(url, {
    trafficAccessToken,
    hydrationTimeoutMs,
    expectedTexts,
  });
  diagnostics.previewReadyMs = Date.now() - readyStarted;
  diagnostics.browserNavigationStatus = browserProbe.navigationStatus;
  diagnostics.hydrationWaitReason = browserProbe.hydrationWaitReason;

  let domProbe: {
    httpStatus?: number;
    domText: string;
    visibleElements: number;
    consoleErrors: string[];
    pageErrors: string[];
  } | undefined;

  if (browserProbe.ok) {
    diagnostics.domProbeSource = "browser";
    domProbe = browserProbe;
  } else {
    const steelProbe = await probeSteelPreviewDom(url);
    if (steelProbe) {
      diagnostics.domProbeSource = "steel";
      domProbe = { ...steelProbe, consoleErrors: [], pageErrors: [] };
    } else if (!strictBrowserOnly) {
      diagnostics.domProbeSource = "fetch";
      const fetchProbe = await probePreviewDom(url, trafficAccessToken);
      domProbe = {
        httpStatus: fetchProbe.httpStatus,
        domText: fetchProbe.domText,
        visibleElements: fetchProbe.visibleElements,
        consoleErrors: [],
        pageErrors: fetchProbe.error ? [fetchProbe.error] : [],
      };
    } else {
      domProbe = {
        httpStatus: browserProbe.httpStatus,
        domText: browserProbe.domText,
        visibleElements: browserProbe.visibleElements,
        consoleErrors: browserProbe.consoleErrors,
        pageErrors: [
          ...browserProbe.pageErrors,
          browserProbe.hydrationWaitReason ?? "browser inspect failed before hydration",
        ],
      };
    }
  }

  let screenshot = placeholderScreenshot;
  if (screenshotCapture) {
    screenshot = await captureScreenshot(url, {
      width: screenshotCapture.width,
      height: screenshotCapture.height,
      storageKey: screenshotCapture.storageKey,
      sessionId: screenshotCapture.sessionId,
      extraHTTPHeaders: previewAuthHeaders(trafficAccessToken),
      waitUntil: "networkidle",
      timeout: Math.min(hydrationTimeoutMs, 60_000),
    });
  }

  diagnostics.screenshotMime = screenshotMime(screenshot.dataUri);
  diagnostics.screenshotByteLength = screenshotByteLength(screenshot.dataUri);

  return {
    url,
    httpStatus: domProbe.httpStatus,
    screenshot,
    domText: domProbe.domText,
    visibleElements: domProbe.visibleElements,
    consoleErrors: domProbe.consoleErrors,
    pageErrors: domProbe.pageErrors,
    diagnostics,
  };
}

function isScreenshotResult(value: WorkbenchScreenshotResult | PreviewInspectOptions): value is WorkbenchScreenshotResult {
  return "dataUri" in value && "storageKey" in value;
}

function emptyScreenshot(): WorkbenchScreenshotResult {
  return { dataUri: "", width: 0, height: 0, storageKey: "" };
}

function previewAuthHeaders(trafficAccessToken?: string): Record<string, string> | undefined {
  return trafficAccessToken ? { "X-Access-Token": trafficAccessToken } : undefined;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function waitForPreviewHttp(
  url: string,
  options?: { deadlineMs?: number; intervalMs?: number },
  trafficAccessToken?: string,
): Promise<void> {
  const deadlineMs = options?.deadlineMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + deadlineMs;
  let lastError = "preview not reachable";
  const headers = previewAuthHeaders(trafficAccessToken) ?? {};

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers });
      if (response.status >= 200 && response.status < 400) return;
      lastError = `preview HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Preview not ready at ${url}: ${lastError}`);
}

function isSpaShellHtml(text: string): boolean {
  const stripped = text.replace(/\s+/g, " ");
  const hasRoot = /<div[^>]+id=(["'])root\1/i.test(text);
  const hasInteractiveTag = /<(button|a|input|textarea|select|main|section|article|h1|h2|h3|p|li)\b/i.test(text);
  return hasRoot && !hasInteractiveTag && stripped.length < 2_000;
}

async function probePreviewDom(url: string, trafficAccessToken?: string): Promise<{
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const headers = previewAuthHeaders(trafficAccessToken) ?? {};
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const text = await response.text().catch(() => "");
    const bodyText = htmlToBodyText(text);
    return {
      httpStatus: response.status,
      domText: bodyText.slice(0, 4000),
      visibleElements: countInteractiveTags(text),
    };
  } catch (err) {
    return {
      domText: "",
      visibleElements: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

type BrowserProbeResult = {
  ok: boolean;
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  consoleErrors: string[];
  pageErrors: string[];
  navigationStatus?: string;
  hydrationWaitReason?: string;
};

export async function probeBrowserPreviewDom(
  url: string,
  options?: {
    trafficAccessToken?: string;
    hydrationTimeoutMs?: number;
    expectedTexts?: string[];
  },
): Promise<BrowserProbeResult> {
  const hydrationTimeoutMs = options?.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
  const expectedTexts = options?.expectedTexts ?? [];
  const extraHTTPHeaders = previewAuthHeaders(options?.trafficAccessToken);

  let browser: import("playwright").Browser | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders,
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const navigationStatus = response ? `http_${response.status()}` : "no_response";
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);

    const hydration = await waitForHydratedDom(page, {
      deadlineMs: hydrationTimeoutMs,
      expectedTexts,
    });

    const dom = await readVisibleDom(page);
    const shellOnly = dom.visibleElements <= 0 && isSpaShellHtml(await page.content());

    return {
      ok: hydration.hydrated && dom.visibleElements > 0 && !shellOnly,
      httpStatus: response?.status(),
      domText: dom.bodyText.slice(0, 4000),
      visibleElements: dom.visibleElements,
      consoleErrors,
      pageErrors,
      navigationStatus,
      hydrationWaitReason: hydration.reason,
    };
  } catch (err) {
    pageErrors.push(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      domText: "",
      visibleElements: 0,
      consoleErrors,
      pageErrors,
      navigationStatus: "navigation_error",
      hydrationWaitReason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.resolve(browser?.close()).catch(() => undefined);
  }
}

async function waitForHydratedDom(
  page: import("playwright").Page,
  input: { deadlineMs: number; expectedTexts: string[] },
): Promise<{ hydrated: boolean; reason: string }> {
  const deadline = Date.now() + input.deadlineMs;
  let lastReason = "waiting for hydrated DOM";

  while (Date.now() < deadline) {
    for (const text of input.expectedTexts) {
      try {
        await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 2_000 });
        return { hydrated: true, reason: `visible text '${text}'` };
      } catch {
        lastReason = `expected text '${text}' not visible yet`;
      }
    }

    try {
      await page.waitForSelector(HYDRATION_SELECTORS, { state: "visible", timeout: 2_000 });
      const dom = await readVisibleDom(page);
      if (dom.visibleElements > 0 && dom.bodyText.trim().length >= 3) {
        return { hydrated: true, reason: `visible elements=${dom.visibleElements}` };
      }
      lastReason = `selectors matched but visibleElements=${dom.visibleElements}`;
    } catch {
      lastReason = "no interactive elements visible yet";
    }

    await page.waitForTimeout(500);
  }

  return { hydrated: false, reason: `hydration timeout: ${lastReason}` };
}

async function readVisibleDom(page: import("playwright").Page): Promise<{ bodyText: string; visibleElements: number }> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const visibleElements = Array.from(
      document.body?.querySelectorAll("button,a,input,textarea,select,main,section,article,h1,h2,h3,p,li,[role='button']") ?? [],
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }).length;
    return { bodyText, visibleElements };
  });
}

async function probeSteelPreviewDom(url: string): Promise<{
  httpStatus?: number;
  domText: string;
  visibleElements: number;
} | undefined> {
  if (!steelDomProbeEnabled()) return undefined;
  try {
    const client = new SteelBrowserClient();
    const result = await client.scrape({
      url,
      format: ["html", "cleaned_html"],
      delayMs: 2_500,
    });
    const html = extractSteelHtml(result);
    if (!html) return undefined;
    const bodyText = htmlToBodyText(html);
    return {
      httpStatus: 200,
      domText: bodyText.slice(0, 4000),
      visibleElements: countInteractiveTags(html),
    };
  } catch {
    return undefined;
  }
}

function steelDomProbeEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  if (!getSteelConfig(env).apiKey) return false;
  const provider = (env.WORKBENCH_BROWSER_PROVIDER ?? env.WORKBENCH_SCREENSHOT_PROVIDER ?? "").toLowerCase();
  return provider === "steel" || provider === "steel-browser" || provider === "steel_browser";
}

function extractSteelHtml(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.html === "string" && c.html.trim()) return c.html;
    if (typeof c.cleaned_html === "string" && c.cleaned_html.trim()) return c.cleaned_html;
  }
  if (typeof result.html === "string" && result.html.trim()) return result.html;
  if (typeof result.cleaned_html === "string" && result.cleaned_html.trim()) return result.cleaned_html;
  return undefined;
}

function htmlToBodyText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countInteractiveTags(text: string): number {
  return (text.match(/<(button|a|input|textarea|select|main|section|article|h1|h2|h3|p|li)\b/gi) ?? []).length;
}

function screenshotMime(dataUri: string): string | undefined {
  const match = dataUri.match(/^data:([^;]+);/);
  return match?.[1];
}

function screenshotByteLength(dataUri: string): number | undefined {
  const base64 = dataUri.split(",")[1];
  if (!base64) return undefined;
  return Math.floor((base64.length * 3) / 4);
}
