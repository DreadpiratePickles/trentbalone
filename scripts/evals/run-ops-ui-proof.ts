/**
 * scripts/evals/run-ops-ui-proof.ts — live authenticated browser proof for the
 * Agent Operations Control Tower (Epic E).
 *
 * Points at a running local dev server (BASE_URL, default http://localhost:3000),
 * signs in through the REAL dev credentials provider (no auth bypass), seeds one
 * richly-shaped run via the dev-only /api/dev/ops-proof-seed route, opens the
 * /companies/[id]/ops page, asserts every section is visible with real evidence
 * (not a fabricated "all green"), captures a screenshot, and writes a JSON proof.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/evals/run-ops-ui-proof.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve("artifacts", "live-proofs");
const DAY = new Date().toISOString().slice(0, 10);

type Assertion = { name: string; ok: boolean; detail: string };

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const assertions: Assertion[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    assertions.push({ name, ok, detail });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}\n`);
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

  let companyId = "";
  let runId = "";
  const screenshotPath = path.join(OUT_DIR, `ops-ui-proof-${DAY}.png`);

  try {
    // 1. Real dev-credentials sign-in.
    await page.goto(`${BASE_URL}/auth/signin`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.locator('input[type="email"], input[name="email"]').first().fill("ops-proof@trent.local");
    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue")').first().click();
    await page.waitForURL("**/companies**", { timeout: 30_000 });
    record("auth", true, "signed in via dev credentials provider (ops-proof@trent.local)");

    // 2. Seed the proof run via the dev-only guarded route (carries session cookie).
    const seeded = await page.evaluate(async () => {
      const res = await fetch("/api/dev/ops-proof-seed", { method: "POST" });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    companyId = seeded.body?.companyId ?? "";
    runId = seeded.body?.runId ?? "";
    record("seed", Boolean(companyId && runId), `status=${seeded.status} companyId=${companyId} runId=${runId}`);
    if (!companyId) throw new Error("seed did not return a companyId");

    // 3. Open the Ops Control Tower for the seeded run.
    await page.goto(`${BASE_URL}/companies/${companyId}/ops?runId=${runId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector('[data-testid="ops-detail"]', { timeout: 30_000 });
    record("page-load", true, "ops detail panel rendered for the selected run");

    // 4. Assert every required section is visible.
    const sections: Array<[string, string]> = [
      ["run timeline", '[data-testid="ops-timeline"]'],
      ["run header", '[data-testid="ops-run-head"]'],
      ["diagnostics", '[data-testid="ops-diagnostics"]'],
      ["trust summary", '[data-testid="ops-trust"]'],
      ["evidence ledger", '[data-testid="ops-evidence"]'],
      ["approvals", '[data-testid="ops-approvals"]'],
      ["memory compounding", '[data-testid="ops-memory"]'],
    ];
    for (const [label, sel] of sections) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      record(`section:${label}`, visible, visible ? "visible" : `missing selector ${sel}`);
    }

    // 5. Assert REAL, honest evidence is present (not a fabricated all-green).
    const body = (await page.locator("body").innerText()).toLowerCase();
    record("evidence:real-tool", body.includes("stripe"), "Stripe provider read present in the ledger");
    record("evidence:needs-credentials", body.includes("needs credentials") || body.includes("sentry"), "honest needs-credentials / Sentry gap surfaced");
    record("evidence:blocked-claim", body.includes("claim blocked") || body.includes("blocked claim"), "blocked unverified prose claim surfaced");
    record("memory:prior", body.includes("prior memory available"), "prior-memory-available indicator surfaced");
    record("approval:gated", body.includes("approval") && body.includes("risk"), "approval queue with risk label surfaced");

    // No fabricated 'all green' placeholder text.
    const banned = ["all systems go", "all systems operational", "everything passed", "all green", "no issues detected"];
    const placeholder = banned.find((p) => body.includes(p));
    record("no-fake-all-green", !placeholder, placeholder ? `found banned placeholder "${placeholder}"` : "no placeholder all-green text");

    // Diagnostics must be a genuine mix — at least one not_measured AND not all ok.
    const diagStatuses = await page.locator("[data-diag-id]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-status") ?? ""),
    );
    const hasNotMeasured = diagStatuses.includes("not_measured");
    const allOk = diagStatuses.length > 0 && diagStatuses.every((s) => s === "ok");
    record("diagnostics:honest-mix", hasNotMeasured && !allOk, `statuses=[${diagStatuses.join(", ")}]`);

    // 6. Screenshot.
    await page.screenshot({ path: screenshotPath, fullPage: true });
    record("screenshot", true, screenshotPath);
  } catch (err) {
    record("fatal", false, err instanceof Error ? err.message.slice(0, 300) : String(err));
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  const passed = assertions.every((a) => a.ok);
  const proof = {
    proof: "agent-ops-control-tower-ui",
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    companyId,
    runId,
    route: `/companies/${companyId}/ops?runId=${runId}`,
    authMethod: "next-auth dev credentials provider (email ops-proof@trent.local), JWT session cookie",
    screenshot: screenshotPath,
    consoleErrors,
    assertions,
    passed,
  };
  const jsonPath = path.join(OUT_DIR, `ops-ui-proof-${DAY}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${assertions.filter((a) => a.ok).length}/${assertions.length} assertions passed. Proof: ${jsonPath}\n`);
  process.exitCode = passed ? 0 : 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
