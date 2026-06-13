import fs from "node:fs";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import { runLiveProviderProofs } from "@/lib/live-provider-proofs";

type Args = {
  envFile?: string;
  providers?: string[];
  outFile?: string;
  allowFailures: boolean;
  failOnSkipped: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadEnvFile(args.envFile) : [];
  const report = await runLiveProviderProofs({
    providers: args.providers,
  });
  const output = {
    ...report,
    loadedEnvKeys,
  };

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.outFile) {
    fs.mkdirSync(dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, serialized, "utf8");
  }
  process.stdout.write(serialized);

  const hasFailed = report.summary.failed > 0;
  const hasSkipped = args.failOnSkipped && report.summary.skipped > 0;
  process.exitCode = !args.allowFailures && (hasFailed || hasSkipped) ? 1 : 0;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    allowFailures: false,
    failOnSkipped: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--env-file") {
      if (!next) throw new Error("--env-file requires a path");
      args.envFile = next;
      i++;
      continue;
    }
    if (arg === "--provider") {
      if (!next) throw new Error("--provider requires a provider key or comma-separated list");
      args.providers = [...(args.providers ?? []), ...next.split(",").map((key) => key.trim()).filter(Boolean)];
      i++;
      continue;
    }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a file path");
      args.outFile = next;
      i++;
      continue;
    }
    if (arg === "--allow-failures") {
      args.allowFailures = true;
      continue;
    }
    if (arg === "--fail-on-skipped") {
      args.failOnSkipped = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(path: string): string[] {
  return loadAllowedEvalEnvFile(path, isAllowedProofEnvKey);
}

function isAllowedProofEnvKey(key: string) {
  return [
    "ATTIO_TOKEN",
    "ATTIO_WORKSPACE_URL",
    "RESEND_API_KEY",
    "RESEND_AUTH_TOKEN",
    "RESEND_FROM_EMAIL",
    "TRENT_EMAIL_FROM",
    "EMAIL_FROM",
    "RESEND_FROM_DOMAIN",
    "RESEND_INBOUND_DOMAIN",
    "TRENT_EMAIL_DOMAIN",
    "TRENT_PLATFORM_DOMAIN",
    "BASE_DOMAIN",
    "RESEND_WEBHOOK_SECRET",
    "STRIPE_SECRET_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_API_KEY",
    "POSTHOG_PROJECT_ID",
    "POSTHOG_TEAM_ID",
    "POSTHOG_HOST",
    "POSTHOG_BASE_URL",
    "SENTRY_AUTH_TOKEN",
    "SENTRY_API_TOKEN",
    "SENTRY_ORG",
    "SENTRY_ORGANIZATION",
    "SENTRY_ORG_SLUG",
    "SENTRY_PROJECT",
    "SENTRY_PROJECT_SLUG",
    "SENTRY_PROJECT_ID",
    "X_USER_ACCESS_TOKEN",
    "TWITTER_USER_ACCESS_TOKEN",
    "GITHUB_TOKEN",
    "GITHUBTOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
  ].includes(key);
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index) || "/";
}

function printHelp() {
  console.log([
    "Usage: tsx scripts/evals/run-live-provider-proofs.ts [--env-file PATH] [--provider attio,resend,stripe,posthog,sentry,x,github] [--out PATH]",
    "",
    "Runs read-only live provider proof calls and prints redacted JSON evidence.",
    "Use --allow-failures to bank evidence without failing the process.",
    "Use --fail-on-skipped when selected providers must be configured.",
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
