import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type PostHogReadAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

type PostHogRow = unknown[];

const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";
const WRITE_ACTION_RE = /\b(capture|create|delete|update|patch|identify|alias|flag|feature|cohort)\b/i;

export function createPostHogReadAdapter(options: PostHogReadAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured = Boolean(posthogToken(env) && posthogProjectId(env));

  return {
    name: "PostHog",
    scopes: ["posthog:events:read", "posthog:metrics:read", "analytics:read"],
    availability: configured ? "real" : "unavailable",
    async healthCheck() {
      return posthogToken(env) && posthogProjectId(env) ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return WRITE_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      const token = posthogToken(env);
      const projectId = posthogProjectId(env);
      if (!token || !projectId) {
        return failed(action, "PostHog is not configured. Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID before agents can read real analytics.");
      }
      if (WRITE_ACTION_RE.test(action)) {
        return failed(action, "PostHog adapter is read-only in this agent tool path. Event capture, flag edits, cohorts, and analytics mutations require dedicated product analytics flows.");
      }

      try {
        const days = boundedDays(payload.days);
        const rows = await queryRecentEvents(fetchImpl, {
          token,
          projectId,
          host: posthogHost(env),
          days,
        });
        return {
          adapter: "PostHog",
          action,
          status: "completed",
          summary: summarizePostHogSnapshot(rows),
        };
      } catch (error) {
        return failed(action, `PostHog read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "PostHog",
        action,
        status: WRITE_ACTION_RE.test(action) ? "needs_approval" : "mocked",
        summary: "PostHog dry-run: Trent would read aggregate event metrics without writing analytics data.",
      };
    },
  };
}

export function summarizePostHogSnapshot(rows: PostHogRow[]) {
  const sorted = [...rows].sort((a, b) => numeric(b[1]) - numeric(a[1]));
  const top = sorted.slice(0, 8).map((row) => {
    const event = typeof row[0] === "string" && row[0].trim() ? row[0].trim() : "(unknown event)";
    return `${event}: ${numeric(row[1])}`;
  });

  return [
    `${rows.length} PostHog event row${rows.length === 1 ? "" : "s"} returned.`,
    top.length ? `Top events: ${top.join("; ")}` : "No event rows returned for the selected window.",
  ].join(" ");
}

async function queryRecentEvents(
  fetchImpl: FetchLike,
  input: { token: string; projectId: string; host: string; days: number },
) {
  const response = await fetchImpl(`${input.host}/api/projects/${encodeURIComponent(input.projectId)}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: [
          "select event, count() as events",
          "from events",
          `where timestamp > now() - interval ${input.days} day`,
          "group by event",
          "order by events desc",
          "limit 20",
        ].join(" "),
      },
      name: "trent_agent_metrics_snapshot",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body) || `HTTP ${response.status}`);
  }
  const results = typeof body === "object" && body !== null && Array.isArray((body as { results?: unknown }).results)
    ? (body as { results: unknown[] }).results
    : [];
  return results.filter((row): row is PostHogRow => Array.isArray(row));
}

function posthogToken(env: EnvLike = process.env) {
  return firstNonEmpty(env.POSTHOG_PERSONAL_API_KEY, env.POSTHOG_API_KEY);
}

function posthogProjectId(env: EnvLike = process.env) {
  return firstNonEmpty(env.POSTHOG_PROJECT_ID, env.POSTHOG_TEAM_ID);
}

function posthogHost(env: EnvLike = process.env) {
  return firstNonEmpty(env.POSTHOG_HOST, env.POSTHOG_BASE_URL)?.replace(/\/+$/, "") || DEFAULT_POSTHOG_HOST;
}

function boundedDays(value: unknown) {
  const days = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 7;
  return Math.min(90, Math.max(1, days));
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(body: unknown) {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "PostHog", action, status: "failed", summary };
}
