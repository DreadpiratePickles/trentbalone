import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchExecResult,
  WorkbenchPreviewInspection,
  WorkbenchScreenshotResult,
} from "@/lib/workbench-provider";
import { checkCommand, requiresApproval } from "@/lib/workbench-safety";
import { SteelBrowserClient, getSteelConfig } from "@/lib/steel-browser";

export function backgroundPreviewCommand(command: string, sessionId: string) {
  return `sh -lc ${shellQuote(`nohup ${command} > /tmp/trent-preview-${sessionId}.log 2>&1 &`)}`;
}

/**
 * Default dev-server port for cloud sandboxes. The Workbench starter template
 * binds Vite to 3000 (and the LLM is instructed to keep that), so the proxy
 * exposes 3000. Never default to Vite's built-in 5173 — that caused the wait
 * loop to poll a port the server never bound to.
 */
export const DEFAULT_PREVIEW_PORT = 3000;

/**
 * Extract the intended listen port from a dev/start command.
 * Handles `--port 3000`, `--port=3000`, `-p 3000`, and `PORT=3000 ...`.
 * Returns undefined when no port is specified.
 */
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
  screenshot: WorkbenchScreenshotResult,
  opts?: { trafficAccessToken?: string },
): Promise<WorkbenchPreviewInspection> {
  await waitForPreviewHttp(url, undefined, opts?.trafficAccessToken);
  // DOM probe priority:
  //   1. local Playwright Chromium (real browser, executes the SPA)
  //   2. Steel remote browser (also real — used when local Chromium can't launch,
  //      e.g. on Railway where the host lacks Chromium's system libraries)
  //   3. plain fetch (sees only the static SPA shell — last resort)
  // Steel is essential on serverless/slim hosts: a plain fetch of a Vite app
  // returns an empty <div id="root"></div>, which the verifier reads as "blank
  // after hydration" and fails forever. Steel runs the JS and returns the
  // rendered DOM, so the renders/dom checks can actually pass.
  const domProbe =
    await probeBrowserPreviewDom(url)
    ?? await probeSteelPreviewDom(url)
    ?? await probePreviewDom(url, opts?.trafficAccessToken);
  const probe = domProbe as {
    httpStatus?: number;
    domText: string;
    visibleElements: number;
    consoleErrors?: string[];
    pageErrors?: string[];
    error?: string;
  };
  return {
    url,
    httpStatus: probe.httpStatus,
    screenshot,
    domText: probe.domText,
    visibleElements: probe.visibleElements,
    consoleErrors: probe.consoleErrors ?? [],
    pageErrors: probe.pageErrors ?? (probe.error ? [probe.error] : []),
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Poll until preview URL returns HTTP 2xx/3xx or deadline expires. */
export async function waitForPreviewHttp(
  url: string,
  options?: { deadlineMs?: number; intervalMs?: number },
  trafficAccessToken?: string,
): Promise<void> {
  const deadlineMs = options?.deadlineMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + deadlineMs;
  let lastError = "preview not reachable";
  const headers: Record<string, string> = trafficAccessToken ? { "X-Access-Token": trafficAccessToken } : {};

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

async function probePreviewDom(url: string, trafficAccessToken?: string): Promise<{
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const headers: Record<string, string> = trafficAccessToken ? { "X-Access-Token": trafficAccessToken } : {};
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const text = await response.text().catch(() => "");
    const bodyText = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      httpStatus: response.status,
      domText: bodyText.slice(0, 4000),
      visibleElements: (text.match(/<(button|a|input|textarea|select|main|section|article|h1|h2|h3|p|li)\b/gi) ?? []).length,
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

async function probeBrowserPreviewDom(url: string): Promise<{
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  consoleErrors: string[];
  pageErrors: string[];
} | undefined> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const dom = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      const visibleElements = Array.from(document.body?.querySelectorAll("button,a,input,textarea,select,main,section,article,h1,h2,h3,p,li") ?? [])
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }).length;
      return { bodyText, visibleElements };
    });
    return {
      httpStatus: response?.status(),
      domText: dom.bodyText.slice(0, 4000),
      visibleElements: dom.visibleElements,
      consoleErrors,
      pageErrors,
    };
  } catch {
    return undefined;
  } finally {
    await Promise.resolve(browser?.close()).catch(() => undefined);
  }
}

/**
 * DOM probe via Steel's remote browser. Runs only when STEEL_API_KEY is set and
 * the operator selected Steel (WORKBENCH_BROWSER_PROVIDER / _SCREENSHOT_PROVIDER).
 * Steel executes the page's JavaScript remotely, so it returns the React-rendered
 * HTML — unlike a plain fetch, which only sees the empty SPA shell. Returns
 * undefined on any failure so the plain-fetch fallback still applies.
 */
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
      delayMs: 2_500, // give the SPA time to hydrate
    });
    const html = extractSteelHtml(result);
    if (!html) return undefined;
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      httpStatus: 200,
      domText: bodyText.slice(0, 4000),
      visibleElements: (html.match(/<(button|a|input|textarea|select|main|section|article|h1|h2|h3|p|li)\b/gi) ?? []).length,
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
  // Steel responses vary: { content: { html, cleaned_html } } or top-level html.
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
