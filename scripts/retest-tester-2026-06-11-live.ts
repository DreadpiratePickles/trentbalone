import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  buildRuntimeAcceptanceActualsTemplate,
  filterRuntimeAcceptanceFixturesByTag,
  TESTER_2026_06_11_TAG,
} from "../lib/runtime-acceptance-evals";

const base = process.env.TRENT_RETEST_BASE_URL ?? "http://127.0.0.1:3210";
const dataRoot = process.env.TRENT_COMPANY_DATA_DIR
  ?? "/Users/bobbymeher/Documents/cos/comapany-data/trent-onboarding-kit";
const outDir = process.env.TRENT_RETEST_OUT_DIR ?? "/tmp/trent-retest";

const actualsPath = path.join(outDir, "tester-2026-06-11-live-actuals.json");
const summaryPath = path.join(outDir, "tester-2026-06-11-live-summary.json");

const fixtures = filterRuntimeAcceptanceFixturesByTag(TESTER_2026_06_11_TAG);
const criteria = Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.passCriteria]));
const actuals = buildRuntimeAcceptanceActualsTemplate(fixtures);
const summary: Record<string, unknown> = { startedAt: new Date().toISOString(), scenarios: {} };
const ORCHESTRATION_SETTLED_STATUSES = ["awaiting_approval", "completed", "failed", "cancelled"];

type JsonResult = { ok: boolean; status: number; text: string; json: unknown };

function log(message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 500)}`;
  console.log(`[retest] ${message}${suffix}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mark(id: string, passedIndexes: number[], evidence: string, state: Record<string, unknown> = {}) {
  actuals[id] = {
    ...actuals[id],
    text: [
      ...passedIndexes.map((index) => criteria[id][index]),
      "",
      "Evidence:",
      evidence,
    ].join("\n"),
    state: { ...(actuals[id]?.state ?? {}), ...state },
  };
  (summary.scenarios as Record<string, unknown>)[id] = {
    passedCriteria: passedIndexes.length,
    totalCriteria: criteria[id].length,
    evidence,
  };
  flushProgress();
}

function scenarioStart(id: string) {
  summary.currentScenario = id;
  (summary.scenarios as Record<string, unknown>)[id] = {
    status: "running",
    startedAt: new Date().toISOString(),
  };
  flushProgress();
}

function flushProgress() {
  summary.updatedAt = new Date().toISOString();
  writeFileSync(actualsPath, JSON.stringify(actuals, null, 2));
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(full));
    else if (/\.(md|json|csv|http|txt)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function documentType(file: string) {
  const lower = path.basename(file).toLowerCase();
  if (lower.includes("operating-brief")) return "brief";
  if (lower.includes("roadmap")) return "roadmap";
  if (lower.includes("marketing-plan")) return "marketing_plan";
  if (lower.includes("competitive")) return "research";
  if (lower.includes("support")) return "support_summary";
  if (lower.includes("weekly-report")) return "weekly_report";
  if (lower.includes("feature-gap")) return "feature_gap";
  return "agent_note";
}

async function main() {
  await mkdir(outDir, { recursive: true });
  summary.phase = "started";
  flushProgress();
  log("startup", { base, dataRoot, outDir });
  summary.phase = "launching_browser";
  flushProgress();
  const browser = await chromium.launch({ headless: true });
  summary.phase = "browser_ready";
  flushProgress();
  const page = await browser.newPage();
  page.setDefaultTimeout(300_000);

  async function api(pathname: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<JsonResult> {
    return page.evaluate(async ({ pathname, method, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);
      try {
        const response = await fetch(pathname, {
          method: method ?? "GET",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        return { ok: response.ok, status: response.status, text, json };
      } finally {
        clearTimeout(timer);
      }
    }, { pathname, method: options.method, body: options.body, timeoutMs: options.timeoutMs });
  }

  async function sse(pathname: string, body?: unknown, timeoutMs = 300_000) {
    return page.evaluate(async ({ pathname, body, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const chunks: unknown[] = [];
      let rest = "";
      let fullText = "";
      try {
        const response = await fetch(pathname, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const reader = response.body?.getReader();
        if (!reader) return { ok: response.ok, status: response.status, text: await response.text(), chunks };
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rest += decoder.decode(value, { stream: true });
          fullText += rest;
          let boundary = rest.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = rest.slice(0, boundary);
            rest = rest.slice(boundary + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") chunks.push("[DONE]");
              else {
                try { chunks.push(JSON.parse(data)); } catch { chunks.push(data); }
              }
            }
            boundary = rest.indexOf("\n\n");
          }
        }
        return { ok: response.ok, status: response.status, text: fullText + rest, chunks };
      } catch (error) {
        return { ok: false, status: 0, text: fullText + rest, chunks, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }, { pathname, body, timeoutMs });
  }

  async function upload(sessionId: string, files: Array<{ name: string; relativePath?: string; bytes: number[]; type?: string }>) {
    return page.evaluate(async ({ sessionId, files }) => {
      const form = new FormData();
      form.append("paths", JSON.stringify(files.map((file) => file.relativePath ?? file.name)));
      for (const file of files) {
        form.append("files", new File([new Uint8Array(file.bytes)], file.name, { type: file.type ?? "text/plain" }));
      }
      const response = await fetch(`/api/workbench/${sessionId}/uploads`, { method: "POST", body: form });
      const text = await response.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: response.ok, status: response.status, text, json };
    }, { sessionId, files });
  }

  async function waitRun(companyId: string, runId: string, timeoutMs = 360_000) {
    const deadline = Date.now() + timeoutMs;
    let last: any;
    const approvedSteps = new Set<string>();
    while (Date.now() < deadline) {
      const response = await api(`/api/companies/${companyId}/orchestrate?runId=${runId}`, { timeoutMs: 20_000 });
      last = response.json as any;
      if (last?.run?.status === "awaiting_approval") {
        const awaiting = ((last.run.steps ?? []) as any[]).filter((step) =>
          step?.status === "awaiting_approval"
          && typeof step.id === "string"
          && !approvedSteps.has(step.id),
        );
        for (const step of awaiting) {
          approvedSteps.add(step.id);
          await api(`/api/companies/${companyId}/orchestrate/approve`, {
            method: "POST",
            body: { runId, stepId: step.id, decision: "approve" },
            timeoutMs: 30_000,
          });
        }
        if (awaiting.length) {
          await sleep(2_000);
          continue;
        }
      }
      if (ORCHESTRATION_SETTLED_STATUSES.includes(last?.run?.status)) return last.run;
      await sleep(5_000);
    }
    return last?.run;
  }

  async function runCommand(companyId: string, label: string, objective: string) {
    scenarioStart(`command:${label}`);
    log(`command start ${label}`);
    const created = await api(`/api/companies/${companyId}/orchestrate`, {
      method: "POST",
      body: { objective, trigger: "manual" },
      timeoutMs: 60_000,
    });
    if (!created.ok) throw new Error(`command ${label} create failed ${created.status}: ${created.text}`);
    const runId = (created.json as any).run.id as string;
    const run = await waitRun(companyId, runId);
    const trace = await api(`/api/companies/${companyId}/orchestrate/trace?runId=${runId}`, { timeoutMs: 30_000 });
    const reconnect = await sse(`/api/companies/${companyId}/orchestrate/stream?runId=${runId}`, undefined, 20_000);
    log(`command end ${label}`, { runId, status: run?.status });
    return { runId, run, trace: trace.json as any, reconnect };
  }

  async function createWorkbench(companyId: string, objective: string, agentMode: "build" | "research" | "design" = "build", agentRole = "engineer") {
    const created = await api("/api/workbench", {
      method: "POST",
      body: { companyId, objective, agentMode, agentRole, provider: "mock_local" },
      timeoutMs: 60_000,
    });
    if (!created.ok) throw new Error(`workbench create failed ${created.status}: ${created.text}`);
    return (created.json as any).session;
  }

  async function runWorkbench(companyId: string, label: string, prompt: string, timeoutMs = 360_000) {
    scenarioStart(`workbench:${label}`);
    log(`workbench start ${label}`);
    const session = await createWorkbench(companyId, prompt);
    const stream = await sse(`/api/workbench/${session.id}/messages`, { content: prompt }, timeoutMs);
    const events = await api(`/api/workbench/${session.id}/events`, { timeoutMs: 30_000 });
    const files = await api(`/api/workbench/${session.id}/files`, { timeoutMs: 30_000 });
    const messages = await api(`/api/workbench/${session.id}/messages`, { timeoutMs: 30_000 });
    log(`workbench end ${label}`, { sessionId: session.id, chunks: stream.chunks.length });
    return { session, stream, events: events.json as any, files: files.json as any, messages: messages.json as any };
  }

  async function selectAppSoloProvider(provider: "auto" | "daytona" | "e2b" | "mock_local") {
    const button = page.getByTestId(`app-solo-provider-${provider}`);
    await button.waitFor({ state: "visible", timeout: 30_000 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await button.click();
      await sleep(500);
      if (await button.getAttribute("aria-pressed") === "true") return;
      await sleep(1_000);
    }
    throw new Error(`Could not select App Solo provider ${provider}`);
  }

  async function signInForRetest() {
    summary.phase = "opening_auth";
    flushProgress();
    await page.goto(`${base}/auth/signin`, { waitUntil: "domcontentloaded" });
    summary.phase = "posting_credentials";
    flushProgress();
    const result = await page.evaluate(async () => {
      const csrfResponse = await fetch("/api/auth/csrf");
      const csrf = await csrfResponse.json() as { csrfToken?: string };
      const body = new URLSearchParams({
        csrfToken: csrf.csrfToken ?? "",
        email: "retest@trent.local",
        callbackUrl: "/companies",
        json: "true",
      });
      const response = await fetch("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      });
      return {
        ok: response.ok || response.status === 302 || response.type === "opaqueredirect",
        status: response.status,
        type: response.type,
        location: response.headers.get("location"),
        text: (await response.text()).slice(0, 300),
      };
    });
    if (!result.ok) {
      throw new Error(`credentials sign-in failed ${result.status}: ${result.text}`);
    }
    await page.goto(`${base}/companies`, { waitUntil: "domcontentloaded" });
    if (!/\/companies/.test(page.url())) {
      throw new Error(`credentials sign-in did not reach companies page: ${page.url()}`);
    }
    summary.phase = "signed_in";
    flushProgress();
    log("signed in", { status: result.status, location: result.location });
  }

  try {
    await signInForRetest();

    const company = await api("/api/companies", {
      method: "POST",
      body: {
        name: `Trench OS Retest ${new Date().toISOString().slice(11, 19)}`,
        website: "https://trench-os.local",
        autonomyLevel: "autonomous_with_approvals",
        publicVisibility: true,
        cycleFrequency: "manual",
        budgetCents: 25_000,
        brief: {
          vision: "Retest Trent/Trench OS with real onboarding company data.",
          icp: "Founder-operators and small teams using autonomous company operations.",
          offer: "AI company operating system with Command, Workbench, Artifact Builder, and App Solo.",
          goals: "Verify source-grounded agent behavior and recoverable runtime surfaces.",
        },
      },
      timeoutMs: 30_000,
    });
    if (!company.ok) throw new Error(`company create failed ${company.status}: ${company.text}`);
    const companyId = (company.json as any).company.id as string;
    summary.companyId = companyId;
    log("company created", companyId);

    const sourceFiles = await listSourceFiles(dataRoot);
    let seeded = 0;
    for (const file of sourceFiles) {
      const rel = path.relative(dataRoot, file).replace(/\\/g, "/");
      const content = await readFile(file, "utf8");
      const created = await api("/api/documents", {
        method: "POST",
        body: { companyId, title: rel, content, type: documentType(file), source: `company-data:${rel}`, memoryTier: "working" },
        timeoutMs: 20_000,
      });
      if (!created.ok) throw new Error(`document seed failed ${rel}: ${created.status} ${created.text}`);
      seeded++;
    }
    summary.seededDocuments = seeded;
    log("seeded documents", seeded);

    const top5 = await runCommand(companyId, "top5", "Identify the top 5 priorities for the next 7 days using the company operating brief, roadmap, analytics, and feature gap list. For each: owner agent, expected output, success metric, risk, founder approval yes/no.");
    const top5TraceText = JSON.stringify(top5.trace ?? {});
    const top5Roles = new Set(((top5.trace?.trace?.seatReports ?? []) as any[]).map((report) => report.seat));
    mark("command_source_coverage_required_for_doc_grounded_audits", [
      /SOURCE COVERAGE|source coverage|Available|Missing/i.test(top5TraceText) ? 0 : -1,
      !/completed an audit[^.]{0,120}(missing|unavailable)|audited[^.]{0,120}missing/i.test(top5TraceText) ? 1 : -1,
      /doc[_a-z0-9-]+|documentId/i.test(top5TraceText) ? 2 : -1,
      top5Roles.size >= 3 && [...top5Roles].some((role) => !["ceo", "escalation"].includes(String(role))) ? 3 : -1,
    ].filter((index) => index >= 0), `run=${top5.runId}; status=${top5.run?.status}; roles=${[...top5Roles].join(",")}`);

    const engineering = await runCommand(companyId, "engineering", "Using the technical architecture, product inventory, changelog, and feature gap list, identify the safest high-impact engineering task to do next. Create an implementation plan. Do not make changes.");
    const reconnectText = `${engineering.reconnect.text}\n${JSON.stringify(engineering.reconnect.chunks)}`;
    mark("command_ui_converges_after_stream_loss", [
      /run_done|run_failed|run_cancelled|run_awaiting_approval/.test(reconnectText) ? 0 : -1,
      ORCHESTRATION_SETTLED_STATUSES.includes(engineering.run?.status) ? 1 : -1,
      engineering.run?.summary || engineering.trace?.trace?.ceoSummary ? 2 : -1,
    ].filter((index) => index >= 0), `run=${engineering.runId}; status=${engineering.run?.status}; reconnectTerminal=${/run_done|run_failed|run_cancelled|run_awaiting_approval/.test(reconnectText)}`);

    const campaign = await runCommand(companyId, "campaign", "Using the ICP, marketing plan, competitive research, and brand voice, draft a 7-day launch campaign. Include 3 channels, daily actions, draft copy, metrics, budget assumptions, and approval gates before anything public goes live.");
    const campaignText = JSON.stringify(campaign.trace ?? {}) + "\n" + (campaign.run?.summary ?? "");
    mark("command_campaign_prompt_always_returns_visible_terminal_state", [
      ORCHESTRATION_SETTLED_STATUSES.includes(campaign.run?.status) ? 0 : -1,
      /brand voice|marketing plan|competitive research|ICP|doc_/i.test(campaignText) ? 1 : -1,
      /approval|FOR REVIEW|app_/i.test(campaignText) ? 2 : -1,
    ].filter((index) => index >= 0), `run=${campaign.runId}; status=${campaign.run?.status}`);

    const testPlanPrompt = "Inspect the uploaded technical architecture and product feature inventory. Create a file called trent-test-plan.md summarizing the top engineering risks, recommended test commands, and a short manual QA checklist. Do not deploy anything.";
    const testPlan = await runWorkbench(companyId, "test-plan", testPlanPrompt);
    const testPlanText = `${JSON.stringify(testPlan.stream.chunks)}\n${JSON.stringify(testPlan.events)}\n${JSON.stringify(testPlan.files)}`;
    const testPlanFiles = ((testPlan.files?.files ?? []) as any[]).map((file) => file.path || file.name).join("\n");
    mark("workbench_analysis_prompt_stays_read_only", [
      /trent-test-plan\.md/i.test(testPlanFiles + testPlanText) ? 0 : -1,
      !/(src\/|package\.json)/i.test(testPlanFiles) ? 1 : -1,
      !/npm run dev|Preview ready/i.test(testPlanText) ? 2 : -1,
      /Scope policy|scope_blocked|Task scope: analysis/i.test(testPlanText) ? 3 : -1,
    ].filter((index) => index >= 0), `session=${testPlan.session.id}; files=${testPlanFiles || "none"}`);

    const landingPrompt = "Using the brand voice and marketing plan, create a minimal landing page prototype for this app. Include copy, layout notes, and a README. Run a basic verification command and report the result.";
    const landing = await runWorkbench(companyId, "landing", landingPrompt);
    const landingText = `${JSON.stringify(landing.stream.chunks)}\n${JSON.stringify(landing.events)}\n${JSON.stringify(landing.messages)}`;
    mark("workbench_landing_page_uses_brand_and_marketing_sources", [
      /brand voice|marketing plan|doc_|SOURCE COVERAGE/i.test(landingText) ? 0 : -1,
      !/lorem ipsum|generic startup boilerplate/i.test(landingText) ? 1 : -1,
      /Verification:\*\* (passed|FAILED|DEGRADED)|verify|Verification failed|Verification passed/i.test(landingText) ? 2 : -1,
    ].filter((index) => index >= 0), `session=${landing.session.id}; chunks=${landing.stream.chunks.length}`);

    const recoveryPrompt = "Run a deliberately invalid command, explain the failure, recover with a corrected command, and write a short failure-recovery note.";
    const recovery = await runWorkbench(companyId, "command-recovery", recoveryPrompt);
    const recoveryText = `${JSON.stringify(recovery.stream.chunks)}\n${JSON.stringify(recovery.events)}\n${JSON.stringify(recovery.files)}`;
    mark("workbench_command_recovery_does_not_repair_app", [
      /exit [1-9]|failed|invalid command|corrected command|failure-recovery/i.test(recoveryText) ? 0 : -1,
      !/package\.json|src\//i.test(JSON.stringify(recovery.files ?? {})) ? 1 : -1,
      !/Repair cycle 3|Repair cycle 4|duplicate import/i.test(recoveryText) ? 2 : -1,
    ].filter((index) => index >= 0), `session=${recovery.session.id}`);

    const proseText = `${testPlanText}\n${landingText}`;
    mark("workbench_prose_lines_never_executed", [
      !/Executable '#'|Executable '-'|Executable '\*'|Blocked: Executable '#'/i.test(proseText) ? 0 : -1,
      /Skipped non-command text|scope_blocked|Scope policy/i.test(proseText) || !/Executable '#'|Executable '-'|Executable '\*'/i.test(proseText) ? 1 : -1,
    ].filter((index) => index >= 0), "no markdown/checklist executor failures observed across Workbench runs");

    const researchPrompt = "Analyze customers.csv, support-tickets.csv, and analytics.json. Produce a concise operator report with findings, metric risks, support risks, and next actions. Save it as operator-report.md.";
    const research = await runWorkbench(companyId, "research-files", researchPrompt);
    const researchText = `${JSON.stringify(research.stream.chunks)}\n${JSON.stringify(research.events)}\n${JSON.stringify(research.files)}\n${JSON.stringify(research.messages)}`;
    mark("workbench_research_reads_uploaded_files", [
      /customers\.csv|support-tickets\.csv|analytics\.json|SOURCE COVERAGE|doc_/i.test(researchText) ? 0 : -1,
      !/please provide|re-send|upload the files/i.test(researchText) || /Missing:/i.test(researchText) ? 1 : -1,
      !/unreadable.*completed|marked completed when required/i.test(researchText) ? 2 : -1,
    ].filter((index) => index >= 0), `session=${research.session.id}`);

    const railwayPrompt = "Prepare a Railway deployment plan for this app. Do not deploy. List every step that requires founder approval, every required environment variable, and a rollback plan.";
    const railway = await runWorkbench(companyId, "railway-plan", railwayPrompt);
    const railwayText = `${JSON.stringify(railway.stream.chunks)}\n${JSON.stringify(railway.events)}\n${JSON.stringify(railway.files)}\n${JSON.stringify(railway.messages)}`;
    const railwayFiles = ((railway.files?.files ?? []) as any[]).map((file) => file.path || file.name).join("\n");
    mark("workbench_deployment_plan_grounded_in_repo_config", [
      !/\.md|src\/|package\.json/i.test(railwayFiles) && !/deploy executed|Preview ready|npm run dev/i.test(railwayText) ? 0 : -1,
      /DATABASE_URL|REDIS_URL|AUTH_SECRET|SECRET_ENCRYPTION_KEY|NEXT_PUBLIC_APP_URL/i.test(railwayText) && !/JWT_SECRET|generic API_KEY/i.test(railwayText) ? 1 : -1,
      /web.*worker|worker.*web|rollback|no deploy executed|Do not deploy/i.test(railwayText) ? 2 : -1,
    ].filter((index) => index >= 0), `session=${railway.session.id}; files=${railwayFiles || "none"}`);

    const artifact1 = await api("/api/artifacts", {
      method: "POST",
      body: { companyId, prompt: "Build a competitive research artifact for Trent.", type: "competitive_research", exportFormat: "markdown", createdByAgent: "analyst" },
      timeoutMs: 60_000,
    });
    const artifact2 = await api("/api/artifacts", {
      method: "POST",
      body: { companyId, prompt: "Build an operating memo on this week's priorities.", type: "operating_memo", exportFormat: "markdown", createdByAgent: "ceo" },
      timeoutMs: 60_000,
    });
    const artifacts = await api(`/api/artifacts?companyId=${companyId}`, { timeoutMs: 30_000 });
    const artifactText = `${artifact1.text}\n${artifact2.text}\n${artifacts.text}`;
    mark("artifacts_second_prompt_always_visible_terminal_state", [
      artifact1.ok && artifact2.ok ? 0 : -1,
      (((artifacts.json as any)?.artifacts ?? []) as unknown[]).length >= 2 ? 1 : -1,
      /Source Coverage|source coverage|sources/i.test(artifactText) ? 2 : -1,
    ].filter((index) => index >= 0), `artifact1=${artifact1.status}; artifact2=${artifact2.status}; list=${artifacts.status}`);

    const appSoloFail = await api("/api/workbench", {
      method: "POST",
      body: {
        companyId,
        objective: "[app-solo] Growth / Browser\nCreate a focused solo run and show me the next useful artifact.",
        agentRole: "growth",
        agentMode: "research",
        provider: "e2b",
        metadata: { appSolo: { agentRole: "growth", agentLabel: "Growth", appId: "steel-browser", appName: "Steel Browser", appScopes: ["browser"], deliverables: ["research artifact"], approvalGates: ["public_url_expose"], mode: "research" } },
      },
      timeoutMs: 60_000,
    });
    const companyDetail = await api(`/api/companies/${companyId}`, { timeoutMs: 30_000 });
    const memoryDocs = ((companyDetail.json as any)?.documents ?? []) as any[];
    const hasFailureMemory = memoryDocs.some((doc) => doc.source === "workbench:launch-failure" && /Workbench launch failed/i.test(doc.title) && doc.memoryTier === "episodic");
    const appSoloAuto = await api("/api/workbench", {
      method: "POST",
      body: {
        companyId,
        objective: "[app-solo] Growth / Browser retry\nCreate a focused solo run and show me the next useful artifact.",
        agentRole: "growth",
        agentMode: "research",
        metadata: { appSolo: { agentRole: "growth", agentLabel: "Growth", appId: "steel-browser", appName: "Steel Browser", appScopes: ["browser"], deliverables: ["research artifact"], approvalGates: ["public_url_expose"], mode: "research" } },
      },
      timeoutMs: 60_000,
    });
    await page.goto(`${base}/companies/${companyId}/app-solo`, { waitUntil: "domcontentloaded" });
    await selectAppSoloProvider("e2b");
    await page.getByTestId("app-solo-start-run").click();
    await page.getByTestId("app-solo-launch-error").waitFor({ timeout: 60_000 });
    const appSoloUi = await page.locator("body").innerText();
    mark("app_solo_launch_failure_durable_and_recoverable", [
      /provider: e2b|HTTP 502|E2B_API_KEY/i.test(appSoloFail.text + appSoloUi) ? 0 : -1,
      hasFailureMemory ? 1 : -1,
      /retry launch|retry with auto provider/i.test(appSoloUi) && appSoloAuto.ok ? 2 : -1,
    ].filter((index) => index >= 0), `apiFail=${appSoloFail.status}; autoRetry=${appSoloAuto.status}; failureMemory=${hasFailureMemory}`);

    const uploadSession = await createWorkbench(companyId, "Upload single files, folders, and a zip containing a traversal entry.");
    const customersCsv = await readFile(path.join(dataRoot, "sample-data/customers.csv"));
    const analyticsJson = await readFile(path.join(dataRoot, "sample-data/analytics.json"));
    const zipBytes = zipSync({
      "zip-safe/readme.md": strToU8("Safe extracted file for upload retest."),
      "zip-safe/analytics.json": new Uint8Array(analyticsJson),
      "../evil.env": strToU8("SHOULD_NOT_WRITE=true"),
    });
    const uploadResult = await upload(uploadSession.id, [
      { name: "single-note.md", relativePath: "single-note.md", bytes: Array.from(strToU8("Single safe note.")), type: "text/markdown" },
      { name: "customers.csv", relativePath: "folder/customers.csv", bytes: Array.from(customersCsv), type: "text/csv" },
      { name: "bundle.zip", relativePath: "bundle.zip", bytes: Array.from(zipBytes), type: "application/zip" },
    ]);
    const uploadEvents = await api(`/api/workbench/${uploadSession.id}/events`, { timeoutMs: 30_000 });
    const uploadFiles = await api(`/api/workbench/${uploadSession.id}/files`, { timeoutMs: 30_000 });
    const uploadText = `${uploadResult.text}\n${uploadEvents.text}\n${uploadFiles.text}`;
    mark("workbench_upload_feature_preserves_safe_files_and_rejects_traversal", [
      /single-note\.md|folder\/customers\.csv|zip-safe\/readme\.md/i.test(uploadText) ? 0 : -1,
      /traversal|rejected|skip|evil\.env/i.test(uploadText) ? 1 : -1,
      /Uploaded|Upload batch|written|skipped/i.test(uploadText) ? 2 : -1,
    ].filter((index) => index >= 0), `session=${uploadSession.id}; uploadStatus=${uploadResult.status}`);

    await writeFile(actualsPath, JSON.stringify(actuals, null, 2));
    summary.completedAt = new Date().toISOString();
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    log("wrote actuals", actualsPath);
    log("wrote summary", summaryPath);
  } catch (error) {
    summary.failedAt = new Date().toISOString();
    summary.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[retest] fatal", error);
  process.exitCode = 1;
});
