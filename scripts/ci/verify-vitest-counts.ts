import fs from "node:fs";
import { buildCiTruthReport, compareCiTruthReport, formatCiTruthMarkdown, type CiTruthBaseline } from "@/lib/ci-truth";

type Args = {
  resultsPath: string;
  baselinePath: string;
  outPath?: string;
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vitestJson = JSON.parse(fs.readFileSync(args.resultsPath, "utf8"));
  const baseline = JSON.parse(fs.readFileSync(args.baselinePath, "utf8")) as CiTruthBaseline;
  const report = buildCiTruthReport(vitestJson);
  const comparison = compareCiTruthReport(report, baseline);
  const markdown = formatCiTruthMarkdown(report, comparison);

  if (args.outPath) {
    mkdirpForFile(args.outPath);
    fs.writeFileSync(args.outPath, `${markdown}\n`, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## CI Truth\n\n${markdown}\n`);
  }
  process.stdout.write(`${JSON.stringify({ report, ok: comparison.ok, messages: comparison.messages }, null, 2)}\n`);
  if (!comparison.ok) process.exitCode = 1;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--results") {
      if (!next) throw new Error("--results requires a path");
      args.resultsPath = next;
      i++;
      continue;
    }
    if (arg === "--baseline") {
      if (!next) throw new Error("--baseline requires a path");
      args.baselinePath = next;
      i++;
      continue;
    }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a path");
      args.outPath = next;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.resultsPath) throw new Error("--results is required");
  if (!args.baselinePath) throw new Error("--baseline is required");
  return args as Args;
}

function mkdirpForFile(path: string) {
  const index = path.lastIndexOf("/");
  if (index > 0) fs.mkdirSync(path.slice(0, index), { recursive: true });
}

function printHelp() {
  console.log("Usage: tsx scripts/ci/verify-vitest-counts.ts --results artifacts/ci/vitest-results.json --baseline docs/verification/ci-truth-baseline.json [--out artifacts/ci/ci-truth.md]");
}

main();
