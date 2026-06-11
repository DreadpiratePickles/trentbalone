import type { AgentRole, WorkbenchArtifact, WorkbenchEvent } from "@/lib/types";

export type WorkbenchIdeTerminalLine = {
  id: string;
  command?: string;
  title: string;
  content: string;
  status: WorkbenchEvent["status"];
  exitCode?: number;
  durationMs?: number;
  agentRole?: AgentRole;
  createdAt: string;
};

export type WorkbenchIdeVerifyCheck = {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
};

export type WorkbenchIdeView = {
  terminalLines: WorkbenchIdeTerminalLine[];
  verifyChecks: WorkbenchIdeVerifyCheck[];
  evidenceSummary: WorkbenchIdeEvidenceSummary;
  files: WorkbenchArtifact[];
  screenshots: WorkbenchArtifact[];
  artifacts: WorkbenchArtifact[];
};

export type WorkbenchIdeEvidenceSummary = {
  status: "passing" | "failing" | "missing";
  passCount: number;
  failCount: number;
  skipCount: number;
  failedChecks: string[];
  fileCount: number;
  screenshotCount: number;
  artifactCount: number;
};

export function buildWorkbenchIdeView(input: {
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
}): WorkbenchIdeView {
  const terminalLines = input.events
    .filter((event) => event.type === "shell")
    .map((event) => ({
      id: event.id,
      command: event.command,
      title: event.title,
      content: event.content,
      status: event.status,
      exitCode: typeof event.metadata?.exitCode === "number" ? event.metadata.exitCode : undefined,
      durationMs: event.durationMs,
      agentRole: event.agentRole,
      createdAt: event.createdAt,
    }));

  const verifyChecks = latestVerifyChecks(input.events);
  const files = input.artifacts.filter((artifact) => artifact.kind === "file" || Boolean(artifact.path));
  const screenshots = input.artifacts.filter((artifact) => artifact.kind === "screenshot");

  return {
    terminalLines,
    verifyChecks,
    evidenceSummary: buildEvidenceSummary({
      verifyChecks,
      files,
      screenshots,
      artifacts: input.artifacts,
    }),
    files,
    screenshots,
    artifacts: input.artifacts,
  };
}

function buildEvidenceSummary(input: {
  verifyChecks: WorkbenchIdeVerifyCheck[];
  files: WorkbenchArtifact[];
  screenshots: WorkbenchArtifact[];
  artifacts: WorkbenchArtifact[];
}): WorkbenchIdeEvidenceSummary {
  const passCount = input.verifyChecks.filter((check) => check.status === "pass").length;
  const failCount = input.verifyChecks.filter((check) => check.status === "fail").length;
  const skipCount = input.verifyChecks.filter((check) => check.status === "skip").length;
  const status = input.verifyChecks.length === 0
    ? "missing"
    : failCount > 0
      ? "failing"
      : "passing";
  return {
    status,
    passCount,
    failCount,
    skipCount,
    failedChecks: input.verifyChecks.filter((check) => check.status === "fail").map((check) => check.name),
    fileCount: input.files.length,
    screenshotCount: input.screenshots.length,
    artifactCount: input.artifacts.length,
  };
}

function latestVerifyChecks(events: WorkbenchEvent[]): WorkbenchIdeVerifyCheck[] {
  for (const event of [...events].reverse()) {
    const checks = event.metadata?.checks;
    if (!Array.isArray(checks)) continue;
    return checks
      .map((check) => normalizeCheck(check))
      .filter((check): check is WorkbenchIdeVerifyCheck => Boolean(check));
  }
  return [];
}

function normalizeCheck(check: unknown): WorkbenchIdeVerifyCheck | undefined {
  if (!check || typeof check !== "object") return undefined;
  const record = check as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const status = record.status === "pass" || record.status === "fail" || record.status === "skip" ? record.status : undefined;
  const detail = typeof record.detail === "string" ? record.detail : "";
  if (!name || !status) return undefined;
  return { name, status, detail };
}
