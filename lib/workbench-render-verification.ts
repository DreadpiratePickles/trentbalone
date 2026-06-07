import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchPreviewInspection,
  WorkbenchProviderAdapter,
  WorkbenchScreenshotResult,
} from "@/lib/workbench-provider";
import type { VerifyCheck } from "@/lib/workbench-verify";

export type RenderInspection = {
  ok: boolean;
  detail: string;
  consoleErrors?: string[];
  domSummary?: string;
  visibleText?: string;
};

export type RenderInspector = (previewUrl: string, session: WorkbenchSession) => Promise<RenderInspection>;

export type RenderVerificationResult = {
  checks: VerifyCheck[];
  previewUrl?: string;
  screenshot?: WorkbenchScreenshotResult;
  consoleErrors?: string[];
  domSummary?: string;
  visibleText?: string;
};

export function providerRenderInspector(provider: WorkbenchProviderAdapter): RenderInspector | undefined {
  if (!provider.inspectPreview) return undefined;
  return async (previewUrl, session) => previewInspectionToRenderResult(
    await provider.inspectPreview!(session, previewUrl),
  );
}

export async function verifyRenderedPreview(input: {
  provider: WorkbenchProviderAdapter;
  session: WorkbenchSession;
  renderInspector: RenderInspector;
}): Promise<RenderVerificationResult> {
  const { provider, session, renderInspector } = input;
  try {
    const previewUrl = await provider.getPreviewUrl(session);
    if (!previewUrl) return skippedWebChecks("No preview URL (non-web build)");

    let previewCheck: VerifyCheck = { name: "preview", status: "pass", detail: `Preview URL ready: ${previewUrl}` };
    const screenshot = await provider.screenshot(session, { url: previewUrl });
    if (!screenshot.dataUri) {
      return renderScreenshotFailure(previewUrl, `Blank screenshot at ${previewUrl}`, screenshot, previewCheck);
    }
    if (isPlaceholderScreenshot(screenshot.dataUri)) {
      return renderScreenshotFailure(
        previewUrl,
        `${placeholderScreenshotDetail(screenshot.dataUri, previewUrl)}; screenshot unavailable`,
        screenshot,
        previewCheck,
      );
    }

    const screenshotCheck: VerifyCheck = {
      name: "screenshot",
      status: "pass",
      detail: `Captured ${screenshot.width}x${screenshot.height} screenshot (${screenshot.storageKey})`,
    };
    const inspection = await renderInspector(previewUrl, session);
    const consoleErrors = inspection.consoleErrors ?? [];
    if (isHttpFailureDetail(inspection.detail)) {
      previewCheck = { name: "preview", status: "fail", detail: inspection.detail };
    }
    const domCheck = buildDomCheck(inspection);
    const consoleCheck: VerifyCheck = consoleErrors.length > 0
      ? { name: "console", status: "fail", detail: `Browser errors: ${consoleErrors.slice(0, 5).join(" | ")}` }
      : { name: "console", status: "pass", detail: "No browser console errors captured" };

    const renderStatus = inspection.ok ? "pass" : "fail";
    return {
      checks: [
        previewCheck,
        screenshotCheck,
        domCheck,
        consoleCheck,
        {
          name: "renders",
          status: renderStatus,
          detail: inspection.ok
            ? `Rendered ${previewUrl}; ${inspection.detail}`
            : `DOM inspection failed for ${previewUrl}: ${inspection.detail}`,
        },
      ],
      previewUrl,
      screenshot,
      consoleErrors,
      domSummary: inspection.domSummary,
      visibleText: inspection.visibleText,
    };
  } catch (err) {
    return {
      checks: [
        { name: "preview", status: "fail", detail: errText(err) },
        { name: "screenshot", status: "skip", detail: "Preview check failed before screenshot capture" },
        { name: "dom", status: "skip", detail: "Preview check failed before DOM inspection" },
        { name: "console", status: "skip", detail: "Preview check failed before console inspection" },
        { name: "renders", status: "fail", detail: errText(err) },
      ],
    };
  }
}

export async function inspectRenderedPreview(previewUrl: string): Promise<RenderInspection> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    const response = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(400);

    const dom = await page.evaluate(() => {
      const root = document.querySelector("#root");
      const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      const visibleElements = Array.from(document.body?.querySelectorAll("button,a,input,textarea,select,main,section,article,h1,h2,h3,p,li") ?? [])
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }).length;
      return {
        bodyText,
        rootText: root?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        rootChildren: root?.children.length ?? null,
        visibleElements,
        title: document.title,
      };
    });

    const domSummary = [
      `title="${dom.title}"`,
      `rootChildren=${dom.rootChildren ?? "missing"}`,
      `rootText=${dom.rootText.length}`,
      `bodyText=${dom.bodyText.length}`,
      `visibleElements=${dom.visibleElements}`,
    ].join(" ");
    if (response && !response.ok()) {
      return { ok: false, detail: `HTTP ${response.status()} ${response.statusText()}`, consoleErrors: browserErrors, domSummary, visibleText: dom.bodyText };
    }
    if (browserErrors.length > 0) {
      return { ok: false, detail: `Browser errors: ${browserErrors.slice(0, 5).join(" | ")}`, consoleErrors: browserErrors, domSummary, visibleText: dom.bodyText };
    }
    if (dom.rootChildren === 0 && dom.rootText.length === 0) {
      return { ok: false, detail: "React root is empty after hydration", consoleErrors: browserErrors, domSummary, visibleText: dom.bodyText };
    }
    if (dom.bodyText.length < 3 && dom.visibleElements === 0) {
      return { ok: false, detail: "Preview body is blank after hydration", consoleErrors: browserErrors, domSummary, visibleText: dom.bodyText };
    }
    return {
      ok: true,
      detail: `${dom.visibleElements} visible elements, ${dom.bodyText.length} text chars`,
      consoleErrors: browserErrors,
      domSummary,
      visibleText: dom.bodyText,
    };
  } catch (err) {
    return { ok: false, detail: `Browser render inspection failed: ${errText(err)}` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function previewInspectionToRenderResult(inspection: WorkbenchPreviewInspection): RenderInspection {
  const errors = [...inspection.consoleErrors, ...inspection.pageErrors];
  const domText = inspection.domText.replace(/\s+/g, " ").trim();
  const domSummary = [
    inspection.httpStatus ? `httpStatus=${inspection.httpStatus}` : "",
    `textChars=${domText.length}`,
    `visibleElements=${inspection.visibleElements}`,
  ].filter(Boolean).join(" ");
  if (typeof inspection.httpStatus === "number" && inspection.httpStatus >= 400) {
    return { ok: false, detail: `HTTP ${inspection.httpStatus}`, consoleErrors: errors, domSummary, visibleText: domText };
  }
  if (errors.length > 0) {
    return { ok: false, detail: `Browser errors: ${errors.slice(0, 5).join(" | ")}`, consoleErrors: errors, domSummary, visibleText: domText };
  }
  if (domText.length < 3 && inspection.visibleElements === 0) {
    return { ok: false, detail: "Preview body is blank after hydration", consoleErrors: errors, domSummary, visibleText: domText };
  }
  return {
    ok: true,
    detail: `${inspection.visibleElements} visible elements, ${domText.length} text chars`,
    consoleErrors: errors,
    domSummary,
    visibleText: domText,
  };
}

function buildDomCheck(inspection: RenderInspection): VerifyCheck {
  if (inspection.ok) {
    return { name: "dom", status: "pass", detail: inspection.domSummary ?? inspection.detail };
  }
  return {
    name: "dom",
    status: isHttpFailureDetail(inspection.detail) ? "skip" : "fail",
    detail: inspection.domSummary ? `${inspection.detail}; ${inspection.domSummary}` : inspection.detail,
  };
}

function skippedWebChecks(detail: string): RenderVerificationResult {
  return {
    checks: [
      { name: "preview", status: "skip", detail },
      { name: "screenshot", status: "skip", detail },
      { name: "dom", status: "skip", detail },
      { name: "console", status: "skip", detail },
      { name: "renders", status: "skip", detail },
    ],
  };
}

async function renderScreenshotFailure(
  previewUrl: string,
  screenshotFailure: string,
  screenshot?: WorkbenchScreenshotResult,
  previewCheck?: VerifyCheck,
): Promise<RenderVerificationResult> {
  const probe = await probeHttpPreview(previewUrl);
  const resolvedPreviewCheck: VerifyCheck = probe.ok
    ? (previewCheck ?? { name: "preview", status: "pass", detail: `Preview URL ready: ${previewUrl}` })
    : { name: "preview", status: "fail", detail: probe.detail };
  const detail = probe.ok
    ? `${screenshotFailure}; HTTP shell is reachable (${probe.detail}) but a static shell is not proof the app rendered — browser screenshot/DOM proof is required.`
    : `${screenshotFailure}; HTTP probe failed: ${probe.detail}`;
  return {
    checks: [
      resolvedPreviewCheck,
      { name: "screenshot", status: "fail", detail },
      { name: "dom", status: "skip", detail: "DOM inspection skipped because screenshot proof failed" },
      { name: "console", status: "skip", detail: "Console inspection skipped because screenshot proof failed" },
      { name: "renders", status: "fail", detail },
    ],
    previewUrl,
    screenshot,
  };
}

async function probeHttpPreview(previewUrl: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(previewUrl, { redirect: "follow", signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "unknown content type";
    const body = await response.text().catch(() => "");
    const trimmed = body.trim();
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} ${response.statusText}`.trim() };
    if (!trimmed) return { ok: false, detail: `HTTP ${response.status} returned an empty body` };
    if (trimmed.includes("Preview placeholder")) return { ok: false, detail: "preview returned a placeholder page" };
    if (!looksLikeRenderedHtml(trimmed, contentType)) {
      return { ok: false, detail: `HTTP ${response.status} returned ${contentType} without an HTML app shell` };
    }
    return { ok: true, detail: `HTTP preview rendered ${response.status} ${contentType} (${trimmed.length} bytes)` };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeRenderedHtml(body: string, contentType: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("text/html")) return /<html[\s>]|<body[\s>]|<div[\s>]|<main[\s>]|<script[\s>]/i.test(body);
  return /<!doctype html|<html[\s>]|<body[\s>]|<div id=["']root["']|<script type=["']module["']/i.test(body);
}

function isHttpFailureDetail(detail: string): boolean {
  return /^HTTP\s+[4-5]\d\d\b/i.test(detail.trim());
}

function isPlaceholderScreenshot(dataUri: string): boolean {
  if (!dataUri.startsWith("data:image/svg+xml;base64,")) return false;
  try {
    const decoded = Buffer.from(dataUri.split(",")[1] ?? "", "base64").toString("utf8");
    return decoded.includes("Preview placeholder") || decoded.includes("Playwright not installed");
  } catch {
    return true;
  }
}

function placeholderScreenshotDetail(dataUri: string, previewUrl: string): string {
  const prefix = `Screenshot placeholder returned for ${previewUrl}`;
  try {
    const decoded = Buffer.from(dataUri.split(",")[1] ?? "", "base64").toString("utf8");
    const text = decoded
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&amp;/g, "&");
    return text ? `${prefix}: ${text.slice(0, 500)}` : prefix;
  } catch {
    return prefix;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
