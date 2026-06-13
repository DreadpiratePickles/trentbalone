import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Options = {
  envFile?: string;
  out?: string;
  provider?: "daytona" | "e2b";
};

type ProofSummary = {
  startedAt: string;
  completedAt?: string;
  passed: boolean;
  provider: string;
  repository: string;
  companyId?: string;
  sessionId?: string;
  rootPaths?: string[];
  gitCheck?: {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  error?: string;
};

const options = parseArgs(process.argv.slice(2));
loadEnvFile(options.envFile);

const token = firstEnv("GITHUB_TOKEN", "GITHUBTOKEN");
const owner = process.env.GITHUB_OWNER?.trim();
const repo = process.env.GITHUB_REPO?.trim();
const provider = options.provider ?? "daytona";
const repository = owner && repo ? `${owner}/${repo}` : "unknown";
const summary: ProofSummary = {
  startedAt: new Date().toISOString(),
  passed: false,
  provider,
  repository,
};

void main();

async function main(): Promise<void> {
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the live GitHub import proof.");
    if (!token || !owner || !repo) {
      throw new Error("GITHUB_TOKEN/GITHUBTOKEN, GITHUB_OWNER, and GITHUB_REPO are required.");
    }

    const [
      { store },
      { saveGitHubConnection },
      { createWorkbenchSession },
      { startWorkbenchSessionAfterImports },
      { getWorkbenchProvider },
    ] = await Promise.all([
      import("@/lib/store"),
      import("@/lib/github"),
      import("@/lib/workbench"),
      import("@/lib/workbench-session-start"),
      import("@/lib/workbench-provider"),
    ]);
    await import("@/lib/workbench-providers");

    const company = await store.createCompany({
      name: `Live GitHub Import Proof ${Date.now()}`,
      brief: { vision: "Verify private GitHub import into a real Workbench sandbox." },
    });
    summary.companyId = company.id;

    await saveGitHubConnection(company.id, { token, owner, repo });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: `Import private repo ${repository} before agent work starts.`,
      provider,
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      enqueue: false,
    });
    summary.sessionId = session.id;

    const started = await startWorkbenchSessionAfterImports(session.id);
    const adapter = getWorkbenchProvider(started.provider);
    const rootFiles = adapter.getFileTree
      ? await adapter.getFileTree(started, { depth: 2, includeIgnored: false })
      : await adapter.listFiles(started);
    summary.rootPaths = rootFiles.map((file) => file.path).slice(0, 40);

    const gitCheck = await adapter.exec(started, "git rev-parse --is-inside-work-tree");
    summary.gitCheck = {
      exitCode: gitCheck.exitCode,
      stdout: gitCheck.stdout.trim().slice(0, 200),
      stderr: gitCheck.stderr.trim().slice(0, 200),
    };
    if (gitCheck.exitCode !== 0 || !/true/i.test(gitCheck.stdout)) {
      throw new Error(`Imported workspace is not a git checkout: ${gitCheck.stderr || gitCheck.stdout || "no output"}`);
    }
    if (!summary.rootPaths.length) {
      throw new Error("Imported workspace file tree is empty.");
    }

    summary.completedAt = new Date().toISOString();
    summary.passed = true;
  } catch (err) {
    summary.error = err instanceof Error ? err.stack ?? err.message : String(err);
    process.exitCode = 1;
  } finally {
    if (options.out) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
    }
    console.log(JSON.stringify(summary, null, 2));
  }
}

function parseArgs(args: string[]): Options {
  const parsed: Options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env-file") parsed.envFile = args[++i];
    else if (arg === "--out") parsed.out = args[++i];
    else if (arg === "--provider") {
      const value = args[++i];
      if (value !== "daytona" && value !== "e2b") throw new Error("--provider must be daytona or e2b");
      parsed.provider = value;
    }
  }
  return parsed;
}

function loadEnvFile(envFile?: string): void {
  if (!envFile) return;
  const text = envFile.endsWith(".rtf")
    ? execFileSync("textutil", ["-convert", "txt", "-stdout", envFile], { encoding: "utf8" })
    : execFileSync("cat", [envFile], { encoding: "utf8" });

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
