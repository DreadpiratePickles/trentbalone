/**
 * Browser verification of app surfaces (CODEX-FEEDBACK P1-2 discipline):
 * boots nothing itself — point it at a running dev server — signs in via the
 * dev credentials provider, creates a company, then walks the nav surfaces
 * (console, trenchpad, mcp, workbench, cycles) capturing a screenshot and
 * console-error log per surface. Evidence lands in artifacts/browser-verify/.
 *
 * Usage: BASE_URL=http://localhost:3001 npx tsx scripts/evals/run-browser-surface-verify.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve("artifacts", "browser-verify");

type SurfaceResult = {
  surface: string;
  url: string;
  ok: boolean;
  detail: string;
  consoleErrors: string[];
  screenshot: string;
};

async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const results: SurfaceResult[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

  async function record(surface: string, url: string, check: () => Promise<string>) {
    consoleErrors.length = 0;
    let ok = false;
    let detail = "";
    try {
      // Live dashboards poll/stream forever and never reach networkidle;
      // anchor on DOM + explicit selectors instead.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      detail = await check();
      ok = true;
    } catch (err) {
      detail = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    const screenshot = await shot(page, surface).catch(() => "");
    results.push({ surface, url, ok, detail, consoleErrors: [...consoleErrors], screenshot });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${surface} — ${detail}\n`);
  }

  // 1. Sign in through the dev credentials provider.
  await page.goto(`${BASE_URL}/auth/signin`, { waitUntil: "networkidle", timeout: 60_000 });
  await shot(page, "00-signin");
  const emailBox = page.locator('input[type="email"], input[name="email"]').first();
  await emailBox.fill("founder@trent.local");
  await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue")').first().click();
  // The page signs in client-side then sets window.location to /companies.
  await page.waitForURL("**/companies**", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await shot(page, "01-after-signin");

  // 2. Create a company via the API (session cookie carried by the context).
  const created = await page.evaluate(async () => {
    const res = await fetch("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Surface Verify Co", brief: { vision: "browser verification" } }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  const companyId: string | undefined = created.body?.company?.id ?? created.body?.id;
  process.stdout.write(`company create status=${created.status} id=${companyId ?? "none"}\n`);
  if (!companyId) {
    process.stdout.write(`FAIL company-create — ${JSON.stringify(created.body).slice(0, 300)}\n`);
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // 3. Walk the surfaces.
  await record("10-console", `${BASE_URL}/companies/${companyId}`, async () => {
    await page.waitForSelector("nav, aside", { timeout: 15_000 });
    return "company console rendered with navigation";
  });
  await record("11-trenchpad", `${BASE_URL}/companies/${companyId}/trenchpad`, async () => {
    await page.waitForSelector('h1:has-text("Operator workspace")', { timeout: 15_000 });
    return "trenchpad operator workspace rendered (new nav surface)";
  });
  await record("12-mcp", `${BASE_URL}/companies/${companyId}/mcp`, async () => {
    await page.waitForSelector("text=/mcp/i", { timeout: 15_000 });
    return "mcp servers page rendered";
  });
  await record("13-workbench", `${BASE_URL}/companies/${companyId}/workbench`, async () => {
    await page.waitForSelector("text=/workbench|session/i", { timeout: 15_000 });
    return "workbench page rendered";
  });
  await record("14-cycles", `${BASE_URL}/companies/${companyId}/cycles`, async () => {
    await page.waitForSelector("text=/cycle/i", { timeout: 15_000 });
    return "cycles page rendered";
  });
  await record("16-trust", `${BASE_URL}/companies/${companyId}/trust`, async () => {
    await page.waitForSelector(".trust-panel, [class*='trust-panel']", { timeout: 15_000 });
    return "trust panel page rendered";
  });
  // Nav must actually reach trenchpad (the slice this verifies end-to-end).
  // Sidebar items are buttons driving router.push, not anchors.
  await record("15-nav-has-trenchpad", `${BASE_URL}/companies/${companyId}`, async () => {
    // Click handlers attach on hydration; clicking earlier is a silent no-op.
    await page.waitForLoadState("load");
    await page.waitForTimeout(2_500);
    const navButton = page.getByRole("button", { name: "trenchpad", exact: true }).first();
    await navButton.waitFor({ state: "visible", timeout: 15_000 });
    await navButton.click();
    await page.waitForURL(`**/companies/${companyId}/trenchpad`, { timeout: 15_000 });
    return "sidebar nav button navigates to the trenchpad operator workspace";
  });

  const report = { baseUrl: BASE_URL, companyId, at: new Date().toISOString(), results };
  await fs.writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} surfaces verified. Report: ${path.join(OUT_DIR, "report.json")}\n`);
  process.exitCode = failed.length ? 1 : 0;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
