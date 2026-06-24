/**
 * Autonomy scheduler — the loop that makes Trent proactive ("runs while you sleep").
 *
 * The heartbeat (lib/heartbeat.ts) already decides + acts per company, and the
 * orchestration it launches enforces every safety rail (per-action autonomy
 * policy, spend caps, approval gates, audit chain, kill switch). The one missing
 * piece in production was a scheduler to actually fire it on a cadence — Railway
 * runs no Vercel cron, and nothing else triggered cycles. This is that scheduler.
 *
 * Safety by construction:
 *   - OFF unless AUTONOMY_SWEEP_ENABLED=1 (so merging changes nothing).
 *   - Acts ONLY on companies that explicitly opted into `autonomous` mode
 *     (via getCompanyAutonomySettings) and are `active` — never the whole tenant base.
 *   - Optional AUTONOMY_SWEEP_COMPANY_IDS allowlist to validate on one company first.
 *   - Each launched cycle still runs through evaluateAutonomyPolicy + dailySpendLimitCents
 *     + approval gates, so "autonomous" never means "unbounded spend".
 */
import type { Company } from "@/lib/types";
import { store } from "@/lib/store";
import { runCompanyHeartbeat, type HeartbeatReport } from "@/lib/heartbeat";
import { getCompanyAutonomySettings } from "@/lib/autonomy-settings";
import { logger } from "@/lib/logger";

export function autonomySweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTONOMY_SWEEP_ENABLED === "1";
}

/** Optional allowlist of company ids to scope the first prod validation to one company. */
export function parseCompanyAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AUTONOMY_SWEEP_COMPANY_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pure selector: which companies the autonomy loop is allowed to act on.
 * Active + explicitly in `autonomous` mode, optionally restricted to an allowlist.
 */
export function selectAutonomousCompanies(
  companies: Company[],
  opts: { allowlist?: string[] } = {},
): Company[] {
  const allow = opts.allowlist ?? [];
  return companies.filter(
    (c) =>
      c.status === "active" &&
      // Reads brief.autonomy, falling back to the legacy autonomyLevel — only
      // explicit `autonomous` mode qualifies (supervised/manual never auto-run).
      getCompanyAutonomySettings(c).mode === "autonomous" &&
      (allow.length === 0 || allow.includes(c.id)),
  );
}

export type AutonomySweepDeps = {
  listCompanies: () => Promise<Company[]>;
  runHeartbeat: (company: Company) => Promise<HeartbeatReport>;
};

export type AutonomySweepSummary = {
  eligible: number;
  acted: number;
  monitored: number;
  skipped: number;
  reports: HeartbeatReport[];
};

/**
 * Run one autonomy tick: find autonomous-mode companies and let the heartbeat
 * decide + act for each. A failure in one company never aborts the sweep.
 */
export async function runAutonomousSweep(
  opts: { deps?: Partial<AutonomySweepDeps>; allowlist?: string[] } = {},
): Promise<AutonomySweepSummary> {
  const deps: AutonomySweepDeps = {
    listCompanies: opts.deps?.listCompanies ?? (() => store.listCompanies()),
    runHeartbeat: opts.deps?.runHeartbeat ?? runCompanyHeartbeat,
  };

  const companies = await deps.listCompanies();
  const eligible = selectAutonomousCompanies(companies, { allowlist: opts.allowlist });

  const reports: HeartbeatReport[] = [];
  for (const company of eligible) {
    try {
      reports.push(await deps.runHeartbeat(company));
    } catch (err) {
      reports.push({
        companyId: company.id,
        decision: "skip",
        reason: err instanceof Error ? err.message : "heartbeat threw",
      });
    }
  }

  const acted = reports.filter((r) => r.decision === "act").length;
  const monitored = reports.filter((r) => r.decision === "monitor").length;
  const skipped = reports.filter((r) => r.decision === "skip").length;
  logger.info(
    { eligible: eligible.length, acted, monitored, skipped },
    "autonomy.sweep",
  );

  return { eligible: eligible.length, acted, monitored, skipped, reports };
}
