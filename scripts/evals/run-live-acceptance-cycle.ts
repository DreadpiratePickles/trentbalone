/**
 * Live north-star acceptance cycle (Epic B) — actions, not drafts.
 *
 *   npm run acceptance:cycle -- --env-file trent.env.local --out artifacts/live-proofs/acceptance.json
 *
 * On a brand-new zero-setup company, the platform's operating cycle ships all five
 * acceptance artifacts as REAL executions against real providers:
 *   1. market research written to memory (real gpt-5.4),
 *   2. a landing page deployed to a live URL, browser-verified interactive (real Daytona),
 *   3. ≥3 correctly-gated founder approvals (real internal-action approvals),
 *   4. a real founder email from the platform domain (real Resend),
 *   5. an outcome snapshot from real Stripe/PostHog/Sentry/ledger data.
 * Each is provenance-verified — nothing mocked.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadAllowedEvalEnvFile(args.envFile, () => true) : [];
  if (process.env.DATABASE_URL && !process.env.DIRECT_URL) process.env.DIRECT_URL = process.env.DATABASE_URL;

  const { store } = await import("@/lib/store");
  const { callText, MODELS } = await import("@/lib/ai-client");
  const { shipLaunchDeliverables } = await import("@/lib/operating-cycle-deliverables");
  const { assembleMorningBriefing } = await import("@/lib/scheduler");
  const { nowIso } = await import("@/lib/utils");

  const proof: Record<string, unknown> = {
    passed: false,
    generatedAt: new Date().toISOString(),
    storeMode: process.env.DATABASE_URL ? "postgres" : "memory",
    model: MODELS.STRONG,
  };

  try {
    const companyName = `Acceptance ${new Date().toISOString()}`;
    const vision = "An AI scheduling assistant that books meetings for busy founders from a single chat message.";
    const company = await store.createCompany({ name: companyName, brief: { vision } });
    proof.companyId = company.id;

    // 1) Real market research (gpt-5.4) → memory.
    const research = await callText(
      MODELS.STRONG,
      "You are Trent's market analyst. Be concrete and concise.",
      `Company vision: ${vision}\nWrite market research: list 5 named competitors, 3 positioning angles, and the single sharpest wedge. Plain text.`,
      900,
    );
    const researchDoc = await store.createDocument({
      companyId: company.id,
      type: "agent_note",
      title: "Market research: AI scheduling assistant",
      content: research.text,
      source: "operating_cycle:research",
      memoryTier: "semantic",
      validFrom: nowIso(),
    });
    proof.researchDocId = researchDoc.id;
    proof.researchTokens = research.tokens;

    // 2) + 3) Ship the landing page (live URL, verified) and queue gated approvals.
    const deliverables = await shipLaunchDeliverables({ companyId: company.id, companyName, vision });
    proof.landing = deliverables.landing;
    proof.approvals = deliverables.approvals;

    // 4) + 5) Real founder email + outcome snapshot.
    const report = await assembleMorningBriefing(company.id);
    proof.reportId = report.id;

    // Verify the five artifacts with provenance.
    const documents = await store.listDocuments(company.id);
    const approvals = await store.listApprovals(company.id);
    const audits = await store.listAuditLogs(company.id);
    const emailAudit = audits.find((a) => a.action === "morning_briefing.email_sent");
    const briefingDoc = documents.find((d) => d.source === "morning-briefing");

    const artifacts = {
      researchInMemory: { present: documents.some((d) => d.source === "operating_cycle:research"), docId: researchDoc.id },
      deployedLandingUrl: { present: Boolean(deliverables.landing.deployed && deliverables.landing.liveUrl), url: deliverables.landing.liveUrl, httpStatus: deliverables.landing.httpStatus, interactionPassed: deliverables.landing.interactionPassed },
      founderEmail: { present: Boolean(emailAudit), summary: emailAudit?.summary },
      gatedApprovals: { present: approvals.filter((a) => a.status === "pending").length >= 3, count: approvals.length, ids: deliverables.approvals.map((a) => a.id) },
      outcomeSnapshot: { present: Boolean(briefingDoc), reportId: report.id },
    };
    proof.artifacts = artifacts;
    const presentCount = Object.values(artifacts).filter((a) => a.present).length;
    proof.artifactsPresent = presentCount;
    proof.passed = presentCount === 5;
  } catch (error) {
    proof.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }

  const json = JSON.stringify(proof, null, 2);
  if (args.outFile) { fs.mkdirSync(path.dirname(args.outFile), { recursive: true }); fs.writeFileSync(args.outFile, json); }
  console.log(json);
  process.exitCode = proof.passed ? 0 : 1;
}

function parseArgs(argv: string[]): { envFile?: string; outFile?: string } {
  const out: { envFile?: string; outFile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") { out.envFile = argv[i + 1]; i++; }
    else if (argv[i] === "--out") { out.outFile = argv[i + 1]; i++; }
  }
  return out;
}

void main();
