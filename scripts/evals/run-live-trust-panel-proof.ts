/**
 * Epic E — Trust panel browser proof.
 *
 *   npm run trust-panel:proof -- --out artifacts/live-proofs/epicE-trust-panel-2026-06-14.json
 *
 * Boots or reuses a dev server, signs in, seeds run evidence, walks the trust panel
 * UI for clean + blocked scenarios, and saves screenshots + JSON proof.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";

const ALLOWED = new Set(["DATABASE_URL", "DIRECT_URL", "SECRET_ENCRYPTION_KEY"]);

type ScenarioResult = {
  scenario: "clean" | "blocked";
  url: string;
  ok: boolean;
  detail: string;
  screenshot: string;
  hasTrustPanel: boolean;
  hasRunEvidence: boolean;
  badge: "verified" | "blocked" | "missing";
};

async function waitForHealth(baseUrl: string, timeoutMs = 120_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile
    ? loadAllowedEvalEnvFile(args.envFile, (key) => ALLOWED.has(key))
    : [];
  if (process.env.DATABASE_URL && !process.env.DIRECT_URL) {
    process.env.DIRECT_URL = process.env.DATABASE_URL;
  }

  const outDir = path.dirname(args.outFile);
  fs.mkdirSync(outDir, { recursive: true });
  const screenshotDir = path.join(outDir, "epicE-trust-panel-2026-06-14");
  fs.mkdirSync(screenshotDir, { recursive: true });

  let baseUrl = process.env.BASE_URL ?? "http://localhost:3014";
  let devServer: ChildProcess | null = null;

  if (!(await waitForHealth(baseUrl, 3_000))) {
    devServer = spawn("npm", ["run", "dev", "--", "-p", "3014"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: "3014",
        NEXTAUTH_URL: "http://localhost:3014",
        AUTH_SECRET: process.env.AUTH_SECRET ?? "trust-panel-proof-dev-secret",
      },
      stdio: "ignore",
      detached: false,
    });
    baseUrl = "http://localhost:3014";
    const ready = await waitForHealth(baseUrl);
    if (!ready) throw new Error(`Dev server did not become healthy at ${baseUrl}`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const scenarios: ScenarioResult[] = [];

  try {
    await page.goto(`${baseUrl}/auth/signin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "sign in as demo operator" }).click();
    await page.waitForURL("**/companies**", { timeout: 30_000 });

    const created = await page.evaluate(async () => {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Epic E Trust Panel ${new Date().toISOString()}`,
          brief: { vision: "Prove honest-autonomy trust panel in product UI" },
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    const companyId: string | undefined = created.body?.company?.id;
    if (!companyId) throw new Error(`company create failed: ${JSON.stringify(created.body).slice(0, 300)}`);

    const seed = await page.evaluate(async (id) => {
      const res = await fetch(`/api/companies/${id}/trust-panel`, { method: "POST" });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, companyId);
    if (seed.status >= 400) {
      throw new Error(`trust-panel seed failed: ${JSON.stringify(seed.body).slice(0, 300)}`);
    }

    for (const scenario of ["clean", "blocked"] as const) {
      const url = `${baseUrl}/companies/${companyId}/trust?scenario=${scenario}&seat=growth`;
      let ok = false;
      let detail = "";
      let hasTrustPanel = false;
      let hasRunEvidence = false;
      let badge: ScenarioResult["badge"] = "missing";

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector('[data-testid="trust-panel"]', { timeout: 20_000 });
        await page.waitForSelector('[data-testid="trust-run-evidence"]', { timeout: 20_000 });
        hasTrustPanel = true;
        hasRunEvidence = true;

        if (scenario === "clean") {
          await page.waitForSelector('[data-testid="no-unverified-claims-badge"]', { timeout: 10_000 });
          badge = "verified";
          detail = "Clean scenario shows verified badge and run evidence";
        } else {
          await page.waitForSelector('[data-testid="blocked-claims-badge"]', { timeout: 10_000 });
          await page.waitForSelector('[data-testid="trust-violations"]', { timeout: 10_000 });
          badge = "blocked";
          detail = "Blocked scenario shows blocked-claims badge and violation evidence";
        }
        ok = true;
      } catch (error) {
        detail = error instanceof Error ? error.message.slice(0, 300) : String(error);
      }

      const screenshot = path.join(screenshotDir, `${scenario}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
      scenarios.push({
        scenario,
        url,
        ok,
        detail,
        screenshot,
        hasTrustPanel,
        hasRunEvidence,
        badge,
      });
    }

    const proof = {
      passed: scenarios.every((row) => row.ok),
      generatedAt: new Date().toISOString(),
      loadedEnvKeys,
      storeMode: process.env.DATABASE_URL ? "postgres" : "memory",
      baseUrl,
      companyId,
      routeTested: `/companies/${companyId}/trust`,
      scenarios,
      screenshots: scenarios.map((row) => row.screenshot),
      degradedOrBlocked: scenarios
        .filter((row) => row.scenario === "blocked")
        .map((row) => ({ item: "false email claim", status: "failed", evidence: row.detail })),
    };

    fs.writeFileSync(args.outFile, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify(proof, null, 2));
    process.exitCode = proof.passed ? 0 : 1;
  } finally {
    await browser.close();
    if (devServer && !devServer.killed) devServer.kill("SIGTERM");
  }
}

function parseArgs(argv: string[]): { envFile?: string; outFile: string } {
  const out: { envFile?: string; outFile: string } = {
    outFile: "artifacts/live-proofs/epicE-trust-panel-2026-06-14.json",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") {
      out.envFile = argv[i + 1];
      i++;
    } else if (argv[i] === "--out") {
      out.outFile = argv[i + 1];
      i++;
    }
  }
  return out;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
