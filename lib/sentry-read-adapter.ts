import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type SentryReadAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

export type SentryIssueSummary = {
  shortId?: string;
  title?: string;
  level?: string;
  count?: string | number;
  userCount?: string | number;
  permalink?: string;
};

type SentryOrganizationSummary = {
  slug?: string;
};

const SENTRY_BASE = "https://sentry.io/api/0";
const WRITE_ACTION_RE = /\b(resolve|assign|delete|archive|mute|ignore|update|create)\b/i;

export function createSentryReadAdapter(options: SentryReadAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "Sentry",
    scopes: ["sentry:issues:read", "sentry:errors:read", "sentry:project:read"],
    availability: "real",
    async healthCheck() {
      const token = sentryToken(env);
      if (!token) return "needs_credentials";
      if (sentryOrg(env)) return "connected";
      try {
        await discoverSingleSentryOrg(fetchImpl, token);
        return "connected";
      } catch {
        return "needs_credentials";
      }
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return WRITE_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      const token = sentryToken(env);
      if (!token) {
        return failed(action, "Sentry is not configured. Set SENTRY_AUTH_TOKEN before agents can read real production errors.");
      }
      if (WRITE_ACTION_RE.test(action)) {
        return failed(action, "Sentry adapter is read-only in this agent tool path. Resolving, assigning, muting, or deleting issues requires a dedicated approval-gated operations flow.");
      }

      try {
        const org = await resolveSentryOrg(fetchImpl, env, token);
        const project = typeof payload.project === "string" && payload.project.trim()
          ? payload.project.trim()
          : sentryProject(env);
        const issues = await listUnresolvedIssues(fetchImpl, { token, org, project });
        return {
          adapter: "Sentry",
          action,
          status: "completed",
          summary: summarizeSentryIssues(issues),
        };
      } catch (error) {
        return failed(action, `Sentry read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "Sentry",
        action,
        status: WRITE_ACTION_RE.test(action) ? "needs_approval" : "mocked",
        summary: "Sentry dry-run: Trent would read unresolved issues without changing incident state.",
      };
    },
  };
}

export function summarizeSentryIssues(issues: SentryIssueSummary[]) {
  const sorted = [...issues].sort((a, b) => issueCount(b) - issueCount(a));
  const top = sorted.slice(0, 5).map((issue) => {
    const shortId = issue.shortId || "SENTRY";
    const title = issue.title || "(untitled issue)";
    const level = issue.level ? `${issue.level} ` : "";
    const count = issueCount(issue);
    const users = numeric(issue.userCount);
    const userText = users > 0 ? `, ${users} user${users === 1 ? "" : "s"}` : "";
    return `${shortId}: ${level}${title} (${count} event${count === 1 ? "" : "s"}${userText})`;
  });

  return [
    `${issues.length} unresolved issue${issues.length === 1 ? "" : "s"} found in Sentry.`,
    top.length ? `Top issues: ${top.join("; ")}` : "No active unresolved issue details returned.",
  ].join(" ");
}

async function listUnresolvedIssues(fetchImpl: FetchLike, input: { token: string; org: string; project?: string }) {
  const search = new URLSearchParams({ query: "is:unresolved", limit: "25" });
  if (input.project) search.set("project", input.project);
  const response = await fetchImpl(
    `${SENTRY_BASE}/organizations/${encodeURIComponent(input.org)}/issues/?${search.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
      },
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = errorMessage(body) || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!Array.isArray(body)) return [];
  return body.filter((item): item is SentryIssueSummary => typeof item === "object" && item !== null);
}

async function resolveSentryOrg(fetchImpl: FetchLike, env: EnvLike, token: string) {
  const explicit = sentryOrg(env);
  if (explicit) return explicit;
  return discoverSingleSentryOrg(fetchImpl, token);
}

async function discoverSingleSentryOrg(fetchImpl: FetchLike, token: string) {
  const response = await fetchImpl(`${SENTRY_BASE}/organizations/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = errorMessage(body) || `HTTP ${response.status}`;
    throw new Error(`Sentry organization discovery failed: ${detail}`);
  }
  if (!Array.isArray(body)) {
    throw new Error("Sentry organization discovery returned an unexpected response. Set SENTRY_ORG explicitly.");
  }
  const orgs = body.filter((item): item is SentryOrganizationSummary => typeof item === "object" && item !== null);
  const slugs = orgs.map((org) => org.slug).filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0);
  if (slugs.length === 1) return slugs[0];
  throw new Error(`Set SENTRY_ORG explicitly; this token can access ${slugs.length} organizations.`);
}

function sentryToken(env: EnvLike = process.env) {
  return firstNonEmpty(env.SENTRY_AUTH_TOKEN, env.SENTRY_API_TOKEN);
}

function sentryOrg(env: EnvLike = process.env) {
  return firstNonEmpty(env.SENTRY_ORG, env.SENTRY_ORGANIZATION, env.SENTRY_ORG_SLUG);
}

function sentryProject(env: EnvLike = process.env) {
  return firstNonEmpty(env.SENTRY_PROJECT, env.SENTRY_PROJECT_SLUG, env.SENTRY_PROJECT_ID);
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function issueCount(issue: SentryIssueSummary) {
  return numeric(issue.count);
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
  }
  return undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Sentry", action, status: "failed", summary };
}
