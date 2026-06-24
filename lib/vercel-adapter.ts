import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";
import { logger } from "@/lib/logger";
import { resolveToolCredential, type ResolveToolCredentialDeps } from "@/lib/tool-credentials";

const REQUEST_TIMEOUT_MS = 20_000;

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type VercelAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  /** Injectable credential resolver deps (per-company ToolConnection lookup) for tests. */
  credentialDeps?: ResolveToolCredentialDeps;
};

export type VercelCredential = { token: string; teamId?: string };

const ADAPTER_NAME = "Vercel";
const API_BASE = "https://api.vercel.com";
const DEPLOY_ACTIONS = ["deploy", "promote", "redeploy", "publish", "rollback", "alias"];

export function vercelToken(env: EnvLike = process.env): string | undefined {
  const token = env.VERCEL_TOKEN?.trim();
  return token ? token : undefined;
}

function vercelTeamId(env: EnvLike): string | undefined {
  const id = env.VERCEL_TEAM_ID?.trim();
  return id ? id : undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: ADAPTER_NAME, action, status: "failed", summary };
}

function withTeam(teamId: string | undefined, path: string): string {
  if (!teamId) return `${API_BASE}${path}`;
  return `${API_BASE}${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}

type GitSource = { type: "github"; repo: string; ref?: string };

function parseGitSource(value: unknown): GitSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.repo !== "string" || !v.repo.trim()) return undefined;
  return { type: "github", repo: v.repo.trim(), ref: typeof v.ref === "string" ? v.ref : "main" };
}

type InlineFile = { file: string; data: string; encoding?: "base64" };

function parseFiles(value: unknown): InlineFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item): InlineFile[] => {
    if (!item || typeof item !== "object") return [];
    const f = item as Record<string, unknown>;
    if (typeof f.file !== "string" || typeof f.data !== "string") return [];
    // Vercel inline files carry raw content in `data`; binary content must set
    // encoding:"base64" so Vercel decodes it correctly.
    return [f.encoding === "base64" ? { file: f.file, data: f.data, encoding: "base64" } : { file: f.file, data: f.data }];
  });
  return files.length ? files : undefined;
}

/**
 * Real deploys to Vercel — turns a Workbench build (or a GitHub repo Trent
 * created) into a PERMANENT live URL, so the product outlives the ephemeral
 * E2B preview sandbox. Deploys are approval-gated (a publish is an outward
 * side effect); reads (list/status) are not. Gated on VERCEL_TOKEN; fails
 * closed when unconfigured. Free on Vercel's Hobby tier.
 */
export function createVercelAdapter(options: VercelAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Per-company Vercel account (encrypted ToolConnection) first, global env second.
  async function resolveCredential(companyId?: string): Promise<VercelCredential | undefined> {
    const { value } = await resolveToolCredential<VercelCredential>({
      companyId,
      provider: ADAPTER_NAME,
      deps: options.credentialDeps,
      envFallback: () => {
        const token = vercelToken(env);
        if (!token) return undefined;
        const teamId = vercelTeamId(env);
        return teamId ? { token, teamId } : { token };
      },
    });
    return value;
  }

  async function api(cred: VercelCredential, path: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
    const response = await fetchImpl(withTeam(cred.teamId, path), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  return {
    name: ADAPTER_NAME,
    scopes: ["vercel:deploy", "vercel:projects:read", "hosting", "deploy_requires_approval"],
    availability: "real",
    async healthCheck(companyId?: string) {
      const cred = await resolveCredential(companyId);
      if (!cred?.token || !isHttpHeaderValueSafe(cred.token)) return "needs_credentials";
      try {
        const { ok } = await api(cred, "/v2/user", { method: "GET" });
        return ok ? "connected" : "needs_credentials";
      } catch {
        return "needs_credentials";
      }
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return DEPLOY_ACTIONS.some((word) => action.toLowerCase().includes(word));
    },
    async execute(action, payload): Promise<ToolCallRecord> {
      const companyId = typeof payload.companyId === "string" ? payload.companyId : undefined;
      const cred = await resolveCredential(companyId);
      if (!cred?.token) {
        return failed(action, "Vercel is not configured. Connect a Vercel account for this company or set VERCEL_TOKEN.");
      }
      if (!isHttpHeaderValueSafe(cred.token)) {
        return failed(action, malformedCredentialSummary(ADAPTER_NAME));
      }

      const lower = action.toLowerCase();

      // Reads — never approval-gated.
      if (lower.includes("list") || lower.includes("project")) {
        try {
          const { ok, data, status } = await api(cred, "/v9/projects", { method: "GET" });
          if (!ok) return failed(action, `Vercel project list failed (HTTP ${status}).`);
          const projects = Array.isArray(data?.projects) ? data.projects : [];
          return {
            adapter: ADAPTER_NAME,
            action,
            status: "completed",
            summary: `Vercel projects (${projects.length}): ${projects.slice(0, 8).map((p: any) => p?.name).filter(Boolean).join(", ") || "none"}.`,
          };
        } catch (err: unknown) {
          return failed(action, `Vercel request errored: ${(err as Error).message}`);
        }
      }

      // Deploys — approval-gated; the runtime should only reach execute() post-approval.
      if (this.requiresApproval(action)) {
        const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
        if (!name) {
          return failed(action, `Vercel ${action} requires payload.name (the project name).`);
        }
        const gitSource = parseGitSource(payload.gitSource);
        const files = parseFiles(payload.files);
        if (!gitSource && !files) {
          return failed(action, `Vercel ${action} requires either payload.gitSource ({ repo, ref }) or payload.files ([{ file, data }]).`);
        }
        // Default to a throwaway PREVIEW deployment. Promoting to the production
        // domain requires an explicit payload.target === "production" — we never
        // auto-publish agent-generated code to the live alias.
        const target = payload.target === "production" ? "production" : "preview";
        const body: Record<string, unknown> = { name };
        if (target === "production") body.target = "production";
        if (gitSource) body.gitSource = gitSource;
        if (files) body.files = files;
        // Vercel requires projectSettings for inline-file (non-git) deploys; pass
        // the framework when known, else null so it deploys as static/unframework.
        if (typeof payload.framework === "string") body.projectSettings = { framework: payload.framework };
        else if (files) body.projectSettings = { framework: null };

        logger.info({ adapter: ADAPTER_NAME, action, companyId, name, target, source: gitSource ? "git" : "files" }, "vercel.deploy");
        try {
          const { ok, data, status } = await api(cred, "/v13/deployments", { method: "POST", body: JSON.stringify(body) });
          if (!ok) {
            const message = data?.error?.message ?? `HTTP ${status}`;
            return failed(action, `Vercel deploy failed: ${message}.`);
          }
          const url = typeof data?.url === "string" ? data.url : undefined;
          return {
            adapter: ADAPTER_NAME,
            action,
            status: "completed",
            summary: url
              ? `Deployed "${name}" to Vercel (${target}) → https://${url} (state ${data?.readyState ?? "queued"}).`
              : `Vercel ${target} deployment for "${name}" was created (id ${data?.id ?? "unknown"}).`,
          };
        } catch (err: unknown) {
          return failed(action, `Vercel request errored: ${(err as Error).message}`);
        }
      }

      return failed(action, `Unsupported Vercel action "${action}". Supported: deploy, list/projects.`);
    },
    async dryRun(action, payload) {
      const name = typeof payload.name === "string" ? payload.name : "(project)";
      return {
        adapter: ADAPTER_NAME,
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Vercel dry-run: Trent would ${action} "${name}".`,
      };
    },
  };
}
