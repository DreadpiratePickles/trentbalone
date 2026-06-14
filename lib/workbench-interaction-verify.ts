/**
 * Interaction-based verification — clicks/types through the preview like a user
 * to catch Potemkin interfaces (buttons that render but do nothing).
 */

import type { VerifyCheck } from "@/lib/workbench-verify";

export type AcceptanceStep = { action: string; expect: string };

export type InteractionStepOutcome = {
  ok: boolean;
  detail: string;
  consoleLogs: string[];
  networkLogs: string[];
  visibleText?: string;
};

export type InteractionDriver = {
  performStep(step: AcceptanceStep): Promise<InteractionStepOutcome>;
  close?(): Promise<void> | void;
};

export type InteractionFailure = {
  step: AcceptanceStep;
  detail: string;
  consoleLogs: string[];
  networkLogs: string[];
};

export type InteractionVerifyResult = {
  passed: boolean;
  detail: string;
  failures: InteractionFailure[];
  transcript: string;
  consoleLogs: string[];
  networkLogs: string[];
  visibleText?: string;
};

export const DEFAULT_SMOKE_STEPS: AcceptanceStep[] = [
  { action: "click first visible button", expect: "page responds with DOM change or network activity" },
];

export function passingInteractionDriver(): InteractionDriver {
  return {
    async performStep(step) {
      return {
        ok: true,
        detail: `${step.action} → ${step.expect}`,
        consoleLogs: [],
        networkLogs: [],
      };
    },
  };
}

export async function verifyInteractions(input: {
  previewUrl: string;
  steps?: AcceptanceStep[];
  driver: InteractionDriver;
}): Promise<InteractionVerifyResult> {
  const steps = input.steps?.length ? input.steps : DEFAULT_SMOKE_STEPS;
  const failures: InteractionFailure[] = [];
  const transcriptLines: string[] = [`preview=${input.previewUrl}`];
  const consoleLogs: string[] = [];
  const networkLogs: string[] = [];
  let visibleText: string | undefined;

  try {
    for (const step of steps) {
      try {
        const outcome = await input.driver.performStep(step);
        consoleLogs.push(...outcome.consoleLogs);
        networkLogs.push(...outcome.networkLogs);
        visibleText = outcome.visibleText ?? visibleText;
        transcriptLines.push(
          outcome.ok
            ? `PASS action="${step.action}" expect="${step.expect}" → ${outcome.detail}`
            : `FAIL action="${step.action}" expect="${step.expect}" → ${outcome.detail}`,
        );
        if (!outcome.ok) {
          failures.push({
            step,
            detail: outcome.detail,
            consoleLogs: outcome.consoleLogs,
            networkLogs: outcome.networkLogs,
          });
          break;
        }
      } catch (err) {
        const detail = errText(err);
        transcriptLines.push(`FAIL action="${step.action}" expect="${step.expect}" → ${detail}`);
        failures.push({ step, detail, consoleLogs: [], networkLogs: [] });
        break;
      }
    }
  } finally {
    await closeInteractionDriver(input.driver);
  }

  const passed = failures.length === 0;
  const detail = passed
    ? `All ${steps.length} interaction step(s) passed`
    : formatInteractionFailure(failures[0]);

  return {
    passed,
    detail,
    failures,
    transcript: transcriptLines.join("\n"),
    consoleLogs,
    networkLogs,
    visibleText,
  };
}

export function interactionResultToCheck(result: InteractionVerifyResult): VerifyCheck {
  return {
    name: "interaction",
    status: result.passed ? "pass" : "fail",
    detail: result.detail,
  };
}

export function createPlaywrightInteractionDriver(
  previewUrl: string,
  options?: { extraHTTPHeaders?: Record<string, string> },
): InteractionDriver {
  let browser: import("playwright").Browser | undefined;
  let page: import("playwright").Page | undefined;
  const consoleLogs: string[] = [];
  const networkLogs: string[] = [];

  async function ensurePage() {
    if (page) return page;
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: options?.extraHTTPHeaders,
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleLogs.push(message.text());
    });
    page.on("pageerror", (error) => consoleLogs.push(error.message));
    page.on("request", (request) => {
      if (request.resourceType() === "fetch" || request.resourceType() === "xhr") {
        networkLogs.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
    await page.waitForSelector("button,a,input,textarea", { state: "visible", timeout: 30_000 }).catch(() => undefined);
    return page;
  }

  async function closeBrowserResources() {
    const activePage = page;
    const activeBrowser = browser;
    page = undefined;
    browser = undefined;
    await activePage?.close().catch(() => undefined);
    await activeBrowser?.close().catch(() => undefined);
  }

  return {
    async performStep(step) {
      const activePage = await ensurePage();
      const before = await snapshotPageState(activePage);
      await performParsedAction(activePage, step.action);
      await activePage.waitForTimeout(400);
      const after = await snapshotPageState(activePage);
      const visibleText = after.bodyText;

      const expectOk = evaluateExpectation(step.expect, before, after, networkLogs);
      if (!expectOk.ok) {
        return {
          ok: false,
          detail: `${step.action}; ${expectOk.detail}`,
          consoleLogs: [...consoleLogs],
          networkLogs: [...networkLogs],
          visibleText,
        };
      }

      return {
        ok: true,
        detail: `${step.action}; ${expectOk.detail}`,
        consoleLogs: [...consoleLogs],
        networkLogs: [...networkLogs],
        visibleText,
      };
    },
    async close() {
      await closeBrowserResources();
    },
  };
}

async function closeInteractionDriver(driver: InteractionDriver): Promise<void> {
  try {
    await driver.close?.();
  } catch {
    // Driver cleanup must not change interaction pass/fail.
  }
}

async function performParsedAction(page: import("playwright").Page, action: string): Promise<void> {
  const trimmed = action.trim();
  const compoundMatch = trimmed.match(
    /^type\s+['"](.+?)['"]\s+in\s+(.+?)\s+then\s+click\s+first\s+visible\s+button$/i,
  );
  if (compoundMatch) {
    await page.locator(compoundMatch[2].trim()).first().fill(compoundMatch[1], { timeout: 5_000 });
    await page.locator("button:visible").first().click({ timeout: 5_000 });
    return;
  }

  const clickFirstButton = /^click\s+first\s+visible\s+button$/i.test(trimmed);
  if (clickFirstButton) {
    await page.locator("button:visible").first().click({ timeout: 5_000 });
    return;
  }

  const clickMatch = trimmed.match(/^click\s+(.+)$/i);
  if (clickMatch) {
    await page.locator(clickMatch[1].trim()).first().click({ timeout: 5_000 });
    return;
  }

  const typeMatch = trimmed.match(/^type\s+['"](.+?)['"]\s+in\s+(.+)$/i)
    ?? trimmed.match(/^type\s+(.+?)\s+in\s+(.+)$/i);
  if (typeMatch) {
    await page.locator(typeMatch[2].trim()).first().fill(typeMatch[1], { timeout: 5_000 });
    return;
  }

  throw new Error(`Unsupported interaction action: ${action}`);
}

type PageSnapshot = {
  bodyText: string;
  elementCount: number;
};

async function snapshotPageState(page: import("playwright").Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const elementCount = document.body?.querySelectorAll("*").length ?? 0;
    return { bodyText, elementCount };
  });
}

function evaluateExpectation(
  expectClause: string,
  before: PageSnapshot,
  after: PageSnapshot,
  networkLogs: string[],
): { ok: boolean; detail: string } {
  const containsMatch = expectClause.match(/(?:list\s+)?contains\s+['"](.+?)['"]/i);
  if (containsMatch) {
    const needle = containsMatch[1];
    if (after.bodyText.includes(needle)) {
      return { ok: true, detail: `visible text contains '${needle}'` };
    }
    return { ok: false, detail: `list length stayed ${countListItems(after.bodyText)}; visible text missing '${needle}'; no satisfying DOM change` };
  }

  const includesMatch = expectClause.match(/visible\s+text\s+includes\s+['"](.+?)['"]/i);
  if (includesMatch) {
    const needle = includesMatch[1];
    return after.bodyText.includes(needle)
      ? { ok: true, detail: `visible text includes '${needle}'` }
      : { ok: false, detail: `visible text missing '${needle}'` };
  }

  if (/responds|DOM change|network activity/i.test(expectClause)) {
    const domChanged = after.bodyText !== before.bodyText || after.elementCount !== before.elementCount;
    if (domChanged) return { ok: true, detail: "page responded with DOM change" };
    if (networkLogs.length > 0) return { ok: true, detail: `network activity: ${networkLogs.slice(-3).join(" | ")}` };
    return { ok: false, detail: "list length stayed 0; no network call fired; page did not respond" };
  }

  return { ok: false, detail: `unsupported expectation: ${expectClause}` };
}

function countListItems(bodyText: string): number {
  return bodyText.split("\n").filter((line) => line.trim().length > 0).length;
}

function formatInteractionFailure(failure: InteractionFailure): string {
  const logs = [
    failure.detail,
    failure.consoleLogs.length ? `console: ${failure.consoleLogs.slice(0, 5).join(" | ")}` : undefined,
    failure.networkLogs.length ? `network: ${failure.networkLogs.slice(0, 5).join(" | ")}` : undefined,
  ].filter(Boolean);
  return `Interaction failed on action="${failure.step.action}" expect="${failure.step.expect}": ${logs.join("; ")}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
