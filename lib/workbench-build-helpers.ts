import { store } from "@/lib/store";
import type { WorkbenchEvent, WorkbenchEventType, WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { runWorkbenchSelfHealingLoop } from "@/lib/workbench-self-heal";
import { verifyWithRetries } from "@/lib/workbench-verify";
import type { VerifyCheck } from "@/lib/workbench-verify";
import {
  isExternalWriteApprovalBlock,
  pauseWorkbenchForCommandApproval,
  WorkbenchApprovalRequiredError,
} from "@/lib/workbench-approval-gate";
import { nowIso } from "@/lib/utils";

const SNAPSHOT_MAX_FILES = 160;
const SNAPSHOT_MAX_FILE_BYTES = 250_000;
const SNAPSHOT_IGNORE_RE = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage|tmp|\.cache)(\/|$)/;
const SNAPSHOT_BINARY_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|wav|woff2?|ttf|otf)$/i;

export type WorkbenchTextSnapshot = {
  files: Map<string, string>;
};

export async function safeWrite(provider: WorkbenchProviderAdapter, session: WorkbenchSession, path: string, content: string) {
  try {
    await provider.writeFile(session, path, content);
    return { ok: true as const };
  } catch (err) {
    const error = errorText(err);
    await recordEvent(session, "file", "failed", `Failed to write ${path}`, error);
    return { ok: false as const, error };
  }
}

export async function safeExec(provider: WorkbenchProviderAdapter, session: WorkbenchSession, cmd: string) {
  try {
    const r = await provider.exec(session, cmd);
    if (isExternalWriteApprovalBlock(r)) {
      const approvalId = await pauseWorkbenchForCommandApproval(session, cmd);
      throw new WorkbenchApprovalRequiredError(approvalId, cmd);
    }
    if (r.blocked) return { exitCode: 126, output: `Blocked: ${r.blockedReason ?? "policy"}` };
    return { exitCode: r.exitCode, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}` };
  } catch (err) {
    if (err instanceof WorkbenchApprovalRequiredError) throw err;
    return { exitCode: 1, output: errorText(err) };
  }
}

export async function safeListFiles(provider: WorkbenchProviderAdapter, session: WorkbenchSession) {
  try { return await provider.listFiles(session); } catch { return []; }
}

export async function safeSelfHeal(provider: WorkbenchProviderAdapter, session: WorkbenchSession, cmd?: string) {
  try { return await runWorkbenchSelfHealingLoop({ session, provider, command: cmd }); }
  catch { return undefined; }
}

export async function safePreview(provider: WorkbenchProviderAdapter, session: WorkbenchSession) {
  try { return await provider.getPreviewUrl(session); } catch { return undefined; }
}

export async function captureWorkbenchTextSnapshot(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
): Promise<WorkbenchTextSnapshot> {
  const files = await safeListFiles(provider, session);
  const snapshot = new Map<string, string>();
  for (const file of files) {
    if (snapshot.size >= SNAPSHOT_MAX_FILES) break;
    if (file.isDir || shouldSkipSnapshotPath(file.path, file.sizeBytes)) continue;
    try {
      snapshot.set(file.path, await provider.readFile(session, file.path));
    } catch {
      // Binary/unreadable files are left to provider-native snapshots.
    }
  }
  return { files: snapshot };
}

export async function restoreWorkbenchTextSnapshot(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
  snapshot: WorkbenchTextSnapshot,
): Promise<{ restored: string[]; removed: string[]; failed: string[] }> {
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const current = await safeListFiles(provider, session);
  for (const file of current) {
    if (file.isDir || shouldSkipSnapshotPath(file.path, file.sizeBytes)) continue;
    if (snapshot.files.has(file.path)) continue;
    try {
      const result = await provider.exec(session, `rm -f -- ${shellQuote(file.path)}`);
      if (result.exitCode === 0) removed.push(file.path);
      else failed.push(file.path);
    } catch {
      failed.push(file.path);
    }
  }
  for (const [filePath, content] of snapshot.files) {
    try {
      await provider.writeFile(session, filePath, content);
      restored.push(filePath);
    } catch {
      failed.push(filePath);
    }
  }
  return { restored, removed, failed };
}

export async function safeStartPreview(provider: WorkbenchProviderAdapter, session: WorkbenchSession, cmd: string) {
  try {
    if (provider.startPreview) {
      const preview = await provider.startPreview(session, cmd);
      if (isExternalWriteApprovalBlock(preview.result)) {
        const approvalId = await pauseWorkbenchForCommandApproval(session, cmd);
        throw new WorkbenchApprovalRequiredError(approvalId, cmd);
      }
      return {
        url: preview.url,
        result: {
          exitCode: preview.result.exitCode,
          output: `${preview.result.stdout}${preview.result.stderr ? `\n${preview.result.stderr}` : ""}`,
        },
      };
    }
    const result = await safeExec(provider, session, cmd);
    return { url: undefined, result };
  } catch (err) {
    if (err instanceof WorkbenchApprovalRequiredError) throw err;
    return { url: undefined, result: { exitCode: 1, output: errorText(err) } };
  }
}

function shouldSkipSnapshotPath(path: string, sizeBytes = 0): boolean {
  return SNAPSHOT_IGNORE_RE.test(path)
    || SNAPSHOT_BINARY_RE.test(path)
    || sizeBytes > SNAPSHOT_MAX_FILE_BYTES;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function persistLatestWorkbenchCheckpoint(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  verdict: Awaited<ReturnType<typeof verifyWithRetries>>,
) {
  const [existing, refreshed] = await Promise.all([
    store.getWorkbenchCheckpoint(session.id).catch(() => undefined),
    store.getWorkbenchSession(session.id).catch(() => undefined),
  ]);
  const snapshot = provider.snapshot ? await provider.snapshot(session).catch(() => undefined) : undefined;
  const previewUrl = verdict.previewUrl ?? refreshed?.previewUrl ?? existing?.previewUrl;
  const providerSessionId =
    metadataString(snapshot?.metadata, "providerSessionId")
    ?? existing?.providerSessionId
    ?? snapshot?.id;

  await store.upsertWorkbenchCheckpoint({
    companyId: session.companyId,
    sessionId: session.id,
    provider: session.provider,
    providerSessionId,
    workdir: refreshed?.workdir ?? existing?.workdir ?? session.workdir,
    previewUrl,
    activePort: activePortFromUrl(previewUrl) ?? existing?.activePort,
    fileTreeHash: snapshot?.fileTreeHash ?? existing?.fileTreeHash,
    latestVerification: {
      passed: verdict.passed,
      checks: verdict.checks,
      previewUrl,
      screenshotArtifactId: verdict.screenshotArtifactId,
      consoleErrors: verdict.consoleErrors ?? [],
      domSummary: verdict.domSummary,
      failedCommands: verdict.failedCommands ?? [],
      repairPrompt: verdict.repairPrompt,
      updatedAt: nowIso(),
    },
    sandboxExpiresAt: existing?.sandboxExpiresAt,
  });
}

export async function recordEvent(
  session: WorkbenchSession, type: WorkbenchEventType,
  status: "completed" | "failed" | "running", title: string, content: string, command?: string, attemptNo?: number,
): Promise<WorkbenchEvent | undefined> {
  return store.addWorkbenchEvent({
    companyId: session.companyId, sessionId: session.id, type, status, title, content, command,
    agentRole: session.agentRole,
    attemptNo,
  }).catch(() => undefined);
}

export function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function activePortFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const rawPort = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
    const port = Number(rawPort);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeArtifactFilePath(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (!segments.length) return "untitled.txt";

  if (cleaned.startsWith("/workspaces/") || segments[0] === "workspaces") {
    const dateIndex = segments.findIndex((segment) => /^\d{4}-\d{2}-\d{2}$/.test(segment));
    if (dateIndex >= 0 && segments.length > dateIndex + 1) {
      return segments.slice(dateIndex + 1).join("/");
    }
    if (segments.length > 2) return segments.slice(2).join("/");
  }

  return cleaned.startsWith("/") ? segments.join("/") : cleaned;
}

export function failedCheckSummary(checks: VerifyCheck[]): string {
  const failed = checks.filter((check) => check.status === "fail");
  if (!failed.length) return "";
  return [
    "",
    "**Failed checks:**",
    ...failed.map((check) => `- ${check.name}: ${check.detail}`),
  ].join("\n");
}

export async function buildFinalArtifactSummary(sessionId: string): Promise<string> {
  const artifacts = await store.listWorkbenchArtifacts(sessionId).catch(() => []);
  const visible = artifacts
    .filter((artifact) => artifact.kind !== "terminal_log" || artifact.title !== "Workbench memory log")
    .slice(-8);
  if (!visible.length) return "";

  return [
    "**Artifacts:**",
    ...visible.map((artifact) => {
      const target = artifact.path ?? artifact.previewUrl ?? artifact.storageKey;
      const agent = artifact.createdByAgent ? ` · ${artifact.createdByAgent}` : "";
      return `- ${artifact.id}: ${artifact.kind}${target ? ` · ${target}` : ""}${agent}`;
    }),
  ].join("\n");
}

export function isInstallCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/.test(command);
}
