/**
 * Live morning-briefing proof — real founder email + outcome snapshot for a company.
 *   npm run briefing:proof -- --env-file trent.env.local --company-id <id> --out <file>
 */
import fs from "node:fs";
import path from "node:path";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";

async function main() {
  const args = parse(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadAllowedEvalEnvFile(args.envFile, () => true) : [];
  if (process.env.DATABASE_URL && !process.env.DIRECT_URL) process.env.DIRECT_URL = process.env.DATABASE_URL;

  const { store } = await import("@/lib/store");
  const { assembleMorningBriefing } = await import("@/lib/scheduler");

  const proof: Record<string, unknown> = { passed: false, generatedAt: new Date().toISOString(), loadedEnvKeys: loadedEnvKeys.length };
  try {
    let companyId = args.companyId;
    if (!companyId) {
      const company = await store.createCompany({ name: `Briefing ${new Date().toISOString()}`, brief: { vision: "Morning briefing proof." } });
      companyId = company.id;
    }
    proof.companyId = companyId;

    const report = await assembleMorningBriefing(companyId);
    proof.reportId = report.id;
    proof.reportTitle = report.title;

    const audits = await store.listAuditLogs(companyId);
    const emailAudit = audits.find((a) => a.action === "morning_briefing.email_sent");
    const assembledAudit = audits.find((a) => a.action === "morning_briefing.assembled");
    const docs = await store.listDocuments(companyId);
    const briefingDoc = docs.find((d) => d.source === "morning-briefing");

    proof.emailSent = Boolean(emailAudit);
    proof.emailSummary = emailAudit?.summary;
    proof.briefingAssembled = Boolean(assembledAudit);
    proof.outcomeSnapshotInMemory = Boolean(briefingDoc);
    proof.memoryDocCount = docs.length;
    proof.snapshotPreview = (briefingDoc?.content ?? "").split("\n").slice(0, 12);
    proof.passed = Boolean(emailAudit) && Boolean(briefingDoc);
  } catch (error) {
    proof.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }

  const json = JSON.stringify(proof, null, 2);
  if (args.outFile) { fs.mkdirSync(path.dirname(args.outFile), { recursive: true }); fs.writeFileSync(args.outFile, json); }
  console.log(json);
  process.exitCode = proof.passed ? 0 : 1;
}

function parse(argv: string[]): { envFile?: string; companyId?: string; outFile?: string } {
  const o: { envFile?: string; companyId?: string; outFile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") { o.envFile = argv[i + 1]; i++; }
    else if (argv[i] === "--company-id") { o.companyId = argv[i + 1]; i++; }
    else if (argv[i] === "--out") { o.outFile = argv[i + 1]; i++; }
  }
  return o;
}

void main();
