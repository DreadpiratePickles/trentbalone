/**
 * E2B idle-sandbox reaper — cost control for the Workbench.
 *
 * E2B bills per sandbox-hour. The provider sets a per-sandbox timeoutMs so
 * orphans eventually self-expire, but that can be up to 30 min of wasted spend
 * per leaked sandbox. This sweep proactively kills sandboxes that are done or
 * stuck: those whose WorkbenchSession is terminal, true orphans with no session,
 * and any sandbox past a hard max age.
 *
 * Safety: it ONLY ever touches sandboxes tagged `managedBy: trent-workbench`
 * (set at create time), so it can never kill unrelated sandboxes sharing the
 * E2B account. The pure selector is the reviewable core; the E2B/DB wiring is
 * injected so it can be unit-tested without the cloud.
 */
import { Sandbox } from "e2b";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export const MANAGED_BY_TAG = "trent-workbench";
const DEFAULT_MAX_AGE_MS = Number(process.env.E2B_SANDBOX_MAX_AGE_MS ?? 60 * 60 * 1000); // 1h hard ceiling
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "cancelled", "canceled", "error"]);

export type ReaperSandbox = { sandboxId: string; startedAt?: Date; metadata?: Record<string, string> };
export type ReaperSession = { status: string };

export type SandboxReapDeps = {
  listSandboxes: () => Promise<ReaperSandbox[]>;
  /** Map each managed sandbox to its WorkbenchSession status, keyed by sandboxId. */
  loadSessions: (sandboxes: ReaperSandbox[]) => Promise<Map<string, ReaperSession>>;
  killSandbox: (sandboxId: string) => Promise<void>;
};

export type ReapResult = { scanned: number; managed: number; reaped: number; failures: number };

/** Pure: decide which live sandboxes should be killed, and why. */
export function selectSandboxesToReap(input: {
  live: ReaperSandbox[];
  sessions: Map<string, ReaperSession>;
  now: number;
  maxAgeMs: number;
}): Array<{ sandboxId: string; reason: string }> {
  const out: Array<{ sandboxId: string; reason: string }> = [];
  for (const sb of input.live) {
    // Never touch a sandbox Trent didn't create.
    if (sb.metadata?.managedBy !== MANAGED_BY_TAG) continue;
    const ageMs = sb.startedAt ? Math.max(0, input.now - sb.startedAt.getTime()) : 0;
    const session = input.sessions.get(sb.sandboxId);
    if (!session) {
      out.push({ sandboxId: sb.sandboxId, reason: "orphan: no workbench session" });
    } else if (TERMINAL_STATUSES.has(session.status.toLowerCase())) {
      out.push({ sandboxId: sb.sandboxId, reason: `session ${session.status}` });
    } else if (ageMs > input.maxAgeMs) {
      out.push({ sandboxId: sb.sandboxId, reason: `exceeded max age (${Math.round(ageMs / 60000)}m)` });
    }
  }
  return out;
}

/** Orchestration over injected deps — list, map to sessions, kill the idle ones. */
export async function reapIdleSandboxes(opts: {
  deps: SandboxReapDeps;
  now?: number;
  maxAgeMs?: number;
}): Promise<ReapResult> {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const live = await opts.deps.listSandboxes();
  const managed = live.filter((s) => s.metadata?.managedBy === MANAGED_BY_TAG);
  const sessions = await opts.deps.loadSessions(managed);
  const targets = selectSandboxesToReap({ live, sessions, now, maxAgeMs });

  let reaped = 0;
  let failures = 0;
  for (const target of targets) {
    try {
      await opts.deps.killSandbox(target.sandboxId);
      reaped += 1;
      logger.info({ sandboxId: target.sandboxId, reason: target.reason }, "sandbox_reaper.killed");
    } catch (err) {
      failures += 1;
      logger.warn({ sandboxId: target.sandboxId, err: (err as Error).message }, "sandbox_reaper.kill_failed");
    }
  }
  return { scanned: live.length, managed: managed.length, reaped, failures };
}

export function sandboxReaperEnabled(env: Pick<NodeJS.ProcessEnv, string> = process.env): boolean {
  return env.WORKBENCH_DEFAULT_PROVIDER === "e2b" && !!env.E2B_API_KEY;
}

async function defaultListSandboxes(apiKey: string): Promise<ReaperSandbox[]> {
  const paginator = Sandbox.list({ apiKey });
  const out: ReaperSandbox[] = [];
  while (paginator.hasNext) {
    const page = await paginator.nextItems();
    for (const info of page) {
      out.push({ sandboxId: info.sandboxId, startedAt: info.startedAt, metadata: info.metadata });
    }
  }
  return out;
}

async function defaultLoadSessions(sandboxes: ReaperSandbox[]): Promise<Map<string, ReaperSession>> {
  const map = new Map<string, ReaperSession>();
  // Sandboxes are tagged with their WorkbenchSession id at create time.
  const sessionIdToSandbox = new Map<string, string>();
  for (const sb of sandboxes) {
    const sessionId = sb.metadata?.trentSessionId;
    if (sessionId) sessionIdToSandbox.set(sessionId, sb.sandboxId);
  }
  const sessionIds = [...sessionIdToSandbox.keys()];
  if (sessionIds.length === 0) return map;
  const rows = await db.workbenchSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, status: true },
  });
  for (const row of rows) {
    const sandboxId = sessionIdToSandbox.get(row.id);
    if (sandboxId) map.set(sandboxId, { status: row.status });
  }
  return map;
}

/** Entry point for the worker's periodic sweep. No-op unless E2B is the provider. */
export async function runSandboxReaperSweep(opts?: {
  env?: NodeJS.ProcessEnv;
  maxAgeMs?: number;
}): Promise<ReapResult | { skipped: true }> {
  const env = opts?.env ?? process.env;
  if (!sandboxReaperEnabled(env)) return { skipped: true };
  const apiKey = env.E2B_API_KEY as string;
  try {
    const result = await reapIdleSandboxes({
      deps: {
        listSandboxes: () => defaultListSandboxes(apiKey),
        loadSessions: defaultLoadSessions,
        killSandbox: async (sandboxId) => {
          await Sandbox.kill(sandboxId, { apiKey });
        },
      },
      maxAgeMs: opts?.maxAgeMs,
    });
    if (result.reaped > 0 || result.failures > 0) {
      logger.info({ ...result }, "sandbox_reaper.sweep");
    }
    return result;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "sandbox_reaper.sweep_failed");
    return { skipped: true };
  }
}
