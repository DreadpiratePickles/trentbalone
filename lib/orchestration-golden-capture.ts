/**
 * lib/orchestration-golden-capture.ts — orchestration guide Task 2.2 (part 2):
 * failure→golden growth.
 *
 * When a run fails (or the critic escalates/replans) with a reproducible
 * objective, the input is captured as a sanitized fixture and appended to the
 * golden suite. New goldens start `quarantined` — they run through the
 * integration suite and are reported, but cannot fail CI — and are promoted
 * to `blocking` only after human review. Fixtures are JSON files in a
 * reviewable directory, so promotion goes through code review like any other
 * suite change.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { appendAuditLog } from "@/lib/audit-log";
import type { OrchestrationGoldenObjective } from "@/lib/orchestration-eval";
import {
  evaluateOrchestrationTrajectory,
  loadOrchestrationTrajectory,
} from "@/lib/orchestration-eval-trajectory";
import { makeId, nowIso } from "@/lib/utils";

export type OrchestrationGoldenStatus = "quarantined" | "blocking";

export type CapturedOrchestrationGolden = {
  id: string;
  companyId: string;
  runId: string;
  /** Sanitized objective text — this is what re-runs through the suite. */
  objective: string;
  /** Why it was captured: run_failed | critic_escalate | critic_replan (+ sanitized detail). */
  reason: string;
  status: OrchestrationGoldenStatus;
  /** Trajectory assertion failures observed on the failing run, for triage. */
  trajectoryFailureTags: string[];
  capturedAt: string;
  promotedAt?: string;
};

const DEFAULT_GOLDEN_DIR = path.resolve(process.cwd(), "evals", "orchestration-goldens");

export function resolveGoldenDir(dir?: string): string {
  return dir ?? process.env.ORCHESTRATION_GOLDENS_DIR ?? DEFAULT_GOLDEN_DIR;
}

/**
 * Capture is on by default in real runs and off under test runners, so
 * intentionally-failing orchestrator tests cannot pollute the suite.
 * ORCHESTRATION_GOLDEN_CAPTURE=1/0 overrides either way; an explicit dir
 * (tests exercising capture itself) bypasses the gate.
 */
export function goldenCaptureEnabled(): boolean {
  if (process.env.ORCHESTRATION_GOLDEN_CAPTURE === "1") return true;
  if (process.env.ORCHESTRATION_GOLDEN_CAPTURE === "0") return false;
  return process.env.NODE_ENV !== "test" && !process.env.VITEST;
}

const PEM_PATTERN = /-----BEGIN[A-Z\s]+-----[\s\S]*?-----END[A-Z\s]+-----/g;
const BASE64_BLOCK = /[A-Za-z0-9+/]{40,}={0,2}/g;
const BEARER_PATTERN = /\bBearer\s+\S+/gi;
const KEY_PATTERN = /\b(?:sk|rk|pk|ghp|gho|ghs|xox[a-z]|ntn|glpat)[-_][A-Za-z0-9_-]{8,}\b/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Same redaction posture as the provisioners' sanitizeError, applied to fixture text. */
export function sanitizeGoldenText(raw: string): string {
  return raw
    .replace(PEM_PATTERN, "[KEY_MATERIAL_REDACTED]")
    .replace(BEARER_PATTERN, "[BEARER_REDACTED]")
    .replace(KEY_PATTERN, "[KEY_REDACTED]")
    .replace(BASE64_BLOCK, "[REDACTED]")
    .replace(EMAIL_PATTERN, "[EMAIL_REDACTED]");
}

function goldenFile(dir: string, runId: string): string {
  return path.join(dir, `golden-${runId}.json`);
}

/**
 * Append-only: one golden per run id; a second capture for the same run
 * returns the existing fixture untouched.
 */
export async function captureOrchestrationFailureGolden(input: {
  runId: string;
  reason: string;
  dir?: string;
}): Promise<CapturedOrchestrationGolden | undefined> {
  if (!input.dir && !goldenCaptureEnabled()) return undefined;
  const dir = resolveGoldenDir(input.dir);

  const existing = await readGolden(goldenFile(dir, input.runId));
  if (existing) return existing;

  const trajectory = await loadOrchestrationTrajectory(input.runId);
  if (!trajectory.run) return undefined;

  const evaluated = evaluateOrchestrationTrajectory(input.runId, trajectory);
  const golden: CapturedOrchestrationGolden = {
    id: makeId("orcgolden"),
    companyId: trajectory.run.companyId,
    runId: input.runId,
    objective: sanitizeGoldenText(trajectory.run.objective),
    reason: sanitizeGoldenText(input.reason),
    status: "quarantined",
    trajectoryFailureTags: evaluated.failureTags,
    capturedAt: nowIso(),
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(goldenFile(dir, input.runId), `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  await appendAuditLog(
    golden.companyId,
    "system",
    "orchestration.golden.captured",
    "orchestrator_run",
    input.runId,
    `Failure captured as quarantined golden ${golden.id} (${golden.reason}). Review and promote to blocking when reproducible.`,
  ).catch(() => undefined);
  return golden;
}

async function readGolden(file: string): Promise<CapturedOrchestrationGolden | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as CapturedOrchestrationGolden;
    return parsed && typeof parsed.objective === "string" && parsed.id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function listOrchestrationGoldens(dir?: string): Promise<CapturedOrchestrationGolden[]> {
  const resolved = resolveGoldenDir(dir);
  let entries: string[];
  try {
    entries = await fs.readdir(resolved);
  } catch {
    return [];
  }
  const goldens: CapturedOrchestrationGolden[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const golden = await readGolden(path.join(resolved, entry));
    if (golden) goldens.push(golden);
  }
  return goldens;
}

/** Human review gate: flip a reviewed golden to blocking (audited). */
export async function promoteOrchestrationGolden(
  goldenId: string,
  dir?: string,
): Promise<CapturedOrchestrationGolden | undefined> {
  const resolved = resolveGoldenDir(dir);
  const goldens = await listOrchestrationGoldens(resolved);
  const golden = goldens.find((item) => item.id === goldenId);
  if (!golden) return undefined;
  if (golden.status === "blocking") return golden;

  const promoted: CapturedOrchestrationGolden = { ...golden, status: "blocking", promotedAt: nowIso() };
  await fs.writeFile(goldenFile(resolved, golden.runId), `${JSON.stringify(promoted, null, 2)}\n`, "utf8");
  await appendAuditLog(
    golden.companyId,
    "user",
    "orchestration.golden.promoted",
    "orchestrator_run",
    golden.runId,
    `Golden ${golden.id} promoted quarantined → blocking; it now gates the orchestration eval pass rate.`,
  ).catch(() => undefined);
  return promoted;
}

/** Captured goldens as suite objectives, consumable by the integration runner. */
export function goldenObjectives(
  goldens: CapturedOrchestrationGolden[],
  options?: { statuses?: OrchestrationGoldenStatus[] },
): OrchestrationGoldenObjective[] {
  const statuses = new Set(options?.statuses ?? ["blocking"]);
  return goldens
    .filter((golden) => statuses.has(golden.status))
    .map((golden) => ({
      id: golden.id,
      objective: golden.objective,
      teamShape: "full_team" as const,
    }));
}
