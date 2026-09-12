import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConfigManager } from "../../config/ConfigManager.js";
import type { CheckResult, DoctorCheck, DoctorContext, DoctorMode } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHttp } from "../probe.js";

/**
 * Standalone opens the SQLite file and asks SQLite itself; connected asks the deployed app's health
 * endpoint and, crucially, distinguishes a real database from the in-memory fallback the app falls
 * back to when `DATABASE_URL` is unset. That fallback answers "ok" while storing nothing durably.
 */

const CATEGORY = "Database";
const NAME = "Database & State Store";
const REQUIRED_JOURNAL_MODE = "wal";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/** The standalone database file: `DATABASE_URL` if it names a file, else `<profile>/trent.db`. */
export function sqlitePathFor(configManager: ConfigManager): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv !== ":memory:") {
    const stripped = fromEnv.replace(/^file:/, "");
    if (stripped && !stripped.startsWith("postgres")) return path.resolve(stripped);
  }
  return path.join(path.dirname(configManager.getConfigPath()), "trent.db");
}

export function resolveMode(ctx: DoctorContext): DoctorMode {
  if (ctx.mode) return ctx.mode;
  return ctx.healthUrl ?? process.env.TRENT_API_URL ? "connected" : "standalone";
}

function inspectSqlite(dbPath: string): { integrity: string; journalMode: string } {
  const db = new DatabaseSync(dbPath, { readOnly: false });
  try {
    const integrityRow = db.prepare("PRAGMA integrity_check;").get() as
      | { integrity_check?: string }
      | undefined;
    const journalRow = db.prepare("PRAGMA journal_mode;").get() as
      | { journal_mode?: string }
      | undefined;
    return {
      integrity: String(integrityRow?.integrity_check ?? "unknown").toLowerCase(),
      journalMode: String(journalRow?.journal_mode ?? "unknown").toLowerCase(),
    };
  } finally {
    db.close();
  }
}

function standalone(ctx: DoctorContext): CheckResult {
  const dbPath = sqlitePathFor(ctx.configManager);

  if (!fs.existsSync(dbPath)) {
    return result({
      status: "warn",
      message: `No database file at ${dbPath}; nothing has been persisted yet.`,
      fixHint: "Start a run; the database file is created on first write. Nothing needs fixing if you have not run anything yet.",
      details: { mode: "standalone", dbPath },
    });
  }

  let inspection: { integrity: string; journalMode: string };
  try {
    inspection = inspectSqlite(dbPath);
  } catch (err) {
    return result({
      status: "fail",
      message: `${dbPath} could not be read as a SQLite database: ${(err as Error).message}.`,
      fixHint: `Move ${dbPath} aside and let Trent recreate it; the old file is kept so nothing is lost.`,
      details: { mode: "standalone", dbPath },
    });
  }

  const { integrity, journalMode } = inspection;
  const details = { mode: "standalone", dbPath, integrity, journalMode };

  if (integrity !== "ok") {
    return result({
      status: "fail",
      message: `PRAGMA integrity_check on ${dbPath} did not return ok.`,
      fixHint: `Recover with \`sqlite3 ${dbPath} ".recover" | sqlite3 ${dbPath}.recovered\`, then move the recovered file into place.`,
      details,
    });
  }

  if (journalMode !== REQUIRED_JOURNAL_MODE) {
    return result({
      status: "warn",
      message: `journal_mode is "${journalMode}", not "wal"; concurrent readers will block on every write.`,
      fixHint: "Run `trent doctor --fix` to enable WAL.",
      autoFixable: true,
      details,
    });
  }

  return result({
    status: "ok",
    message: `SQLite integrity_check ok, journal_mode wal (${dbPath}).`,
    details,
  });
}

interface HealthBody {
  status?: string;
  checks?: { database?: string };
  readiness?: { db?: string };
}

async function connected(ctx: DoctorContext): Promise<CheckResult> {
  const url = ctx.healthUrl ?? process.env.TRENT_API_URL ?? "";
  const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const healthUrl = url.endsWith("/api/health") ? url : `${url.replace(/\/$/, "")}/api/health`;

  const probe = await probeHttp(
    healthUrl,
    { method: "GET", headers: { accept: "application/json" } },
    { fetchImpl: ctx.fetchImpl, timeoutMs },
  );

  if (probe.kind !== "response") {
    return result({
      status: "warn",
      message: `The health endpoint at ${healthUrl} was ${probe.kind === "timeout" ? `unanswered within ${timeoutMs}ms` : "unreachable"}, so the database could not be inspected.`,
      fixHint: "Confirm the deployment is running and reachable, then re-run `trent doctor`.",
      details: { mode: "connected", healthUrl },
    });
  }

  let body: HealthBody = {};
  try {
    body = (await probe.response.json()) as HealthBody;
  } catch {
    return result({
      status: "fail",
      message: `The health endpoint at ${healthUrl} did not return JSON.`,
      fixHint: "Check that TRENT_API_URL points at the Trent app and not at a proxy error page.",
      details: { mode: "connected", healthUrl, httpStatus: probe.response.status },
    });
  }

  const readinessDb = body.readiness?.db ?? "unknown";
  const details = {
    mode: "connected",
    healthUrl,
    httpStatus: probe.response.status,
    readinessDb,
    databaseCheck: body.checks?.database ?? "unknown",
  };

  if (body.checks?.database === "error" || probe.response.status >= 500) {
    return result({
      status: "fail",
      message: `The deployment reports its database as unhealthy (HTTP ${probe.response.status}).`,
      fixHint: "Inspect the deployment's DATABASE_URL and database availability.",
      details,
    });
  }

  if (readinessDb === "memory") {
    return result({
      status: "warn",
      message:
        "The deployment is running on the in-memory fallback store, not a real database: DATABASE_URL is unset there, so every run is lost on restart.",
      fixHint: "Set DATABASE_URL on the deployment and restart it.",
      details,
    });
  }

  return result({
    status: "ok",
    message: `The deployment reports a real database (readiness.db = ${readinessDb}).`,
    details,
  });
}

export const checkDatabase: DoctorCheck = {
  id: "check_database",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    return resolveMode(ctx) === "connected" ? connected(ctx) : standalone(ctx);
  },
};
