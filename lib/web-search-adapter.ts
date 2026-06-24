import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type WebSearchAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const ADAPTER_NAME = "Web Search";
// Pure research/read tool: it has no external side effects, so nothing here is approval-gated.
const MAX_RESULTS_DEFAULT = 5;
const MAX_RESULTS_CEILING = 10;

function tavilyToken(env: EnvLike): string | undefined {
  const token = env.TAVILY_API_KEY?.trim();
  return token ? token : undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: ADAPTER_NAME, action, status: "failed", summary };
}

function clampResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_RESULTS_DEFAULT;
  return Math.max(1, Math.min(MAX_RESULTS_CEILING, Math.trunc(value)));
}

export function parseTavilyResults(data: unknown): { answer?: string; results: WebSearchResult[] } {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results: WebSearchResult[] = rawResults.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    if (!url) return [];
    return [{
      title: typeof r.title === "string" ? r.title : url,
      url,
      content: typeof r.content === "string" ? r.content : "",
      score: typeof r.score === "number" ? r.score : undefined,
    }];
  });
  return {
    answer: typeof record.answer === "string" && record.answer.trim() ? record.answer.trim() : undefined,
    results,
  };
}

/**
 * Real web search for agents, backed by Tavily (LLM-native search API, generous
 * free tier). Read-only and side-effect free, so it is never approval-gated.
 * Fails closed without TAVILY_API_KEY rather than returning mocked results.
 */
export function createWebSearchAdapter(options: WebSearchAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: ADAPTER_NAME,
    scopes: ["web:search", "web:research", "web:answer"],
    availability: "real",
    async healthCheck() {
      const token = tavilyToken(env);
      if (!token) return "needs_credentials";
      if (!isHttpHeaderValueSafe(token)) return "needs_credentials";
      return "connected";
    },
    estimateCost() {
      // Tavily's free tier covers research-scale usage; treat as no marginal cost.
      return 0;
    },
    requiresApproval() {
      return false;
    },
    async execute(action, payload): Promise<ToolCallRecord> {
      const token = tavilyToken(env);
      if (!token) {
        return failed(action, "Web Search is not configured. Set TAVILY_API_KEY before agents can research the live web.");
      }
      if (!isHttpHeaderValueSafe(token)) {
        return failed(action, malformedCredentialSummary(ADAPTER_NAME));
      }

      const query = typeof payload.query === "string" ? payload.query.trim() : "";
      if (!query) {
        return failed(action, `Web Search action "${action}" requires payload.query.`);
      }

      try {
        const response = await fetchImpl(TAVILY_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query,
            max_results: clampResults(payload.maxResults),
            search_depth: payload.deep === true ? "advanced" : "basic",
            include_answer: true,
          }),
        });

        if (!response.ok) {
          const detail = response.status === 401 || response.status === 403
            ? "credentials were rejected — check TAVILY_API_KEY"
            : `HTTP ${response.status}`;
          return failed(action, `Web Search request failed (${detail}).`);
        }

        const { answer, results } = parseTavilyResults(await response.json().catch(() => ({})));
        if (!results.length && !answer) {
          return { adapter: ADAPTER_NAME, action, status: "completed", summary: `Web Search found no results for "${query}".` };
        }

        const top = results.slice(0, 3).map((r) => `• ${r.title} — ${r.url}`).join("\n");
        const summary = [
          answer ? `Answer: ${answer}` : undefined,
          results.length ? `${results.length} sources for "${query}":\n${top}` : undefined,
        ].filter(Boolean).join("\n\n") || `Web Search completed for "${query}".`;

        return { adapter: ADAPTER_NAME, action, status: "completed", summary };
      } catch (err: unknown) {
        return failed(action, `Web Search request errored: ${(err as Error).message}`);
      }
    },
    async dryRun(action, payload) {
      const query = typeof payload.query === "string" ? payload.query : "";
      return {
        adapter: ADAPTER_NAME,
        action,
        status: "mocked",
        summary: `Web Search dry-run: Trent would search the live web for "${query}".`,
      };
    },
  };
}
