import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe } from "@/lib/http-credential";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type WebReaderAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

const ADAPTER_NAME = "Web Reader";
const JINA_READER_BASE = "https://r.jina.ai/";
const READ_ACTIONS = ["read", "fetch", "extract", "open", "scrape"];
const MAX_CHARS = 8000;

function jinaToken(env: EnvLike): string | undefined {
  const token = env.JINA_API_KEY?.trim();
  return token ? token : undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: ADAPTER_NAME, action, status: "failed", summary };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reads any web page as clean, LLM-ready markdown via Jina Reader
 * (https://r.jina.ai). Free with no key required (an optional JINA_API_KEY
 * raises rate limits). Read-only and side-effect free, so it is never
 * approval-gated. Pairs with the Web Search adapter: search to find sources,
 * read to pull full page content.
 */
export function createWebReaderAdapter(options: WebReaderAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: ADAPTER_NAME,
    scopes: ["web:read", "web:extract"],
    availability: "real",
    async healthCheck() {
      // No credential required — the free tier works out of the box.
      return "connected";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval() {
      return false;
    },
    async execute(action, payload): Promise<ToolCallRecord> {
      if (!READ_ACTIONS.some((word) => action.toLowerCase().includes(word))) {
        return failed(action, `Unsupported Web Reader action "${action}". Supported: ${READ_ACTIONS.join(", ")}.`);
      }
      const url = payload.url;
      if (!isHttpUrl(url)) {
        return failed(action, `Web Reader action "${action}" requires a valid http(s) payload.url.`);
      }

      const headers: Record<string, string> = { Accept: "text/plain" };
      const token = jinaToken(env);
      if (token && isHttpHeaderValueSafe(token)) headers.Authorization = `Bearer ${token}`;

      try {
        const response = await fetchImpl(`${JINA_READER_BASE}${url}`, { method: "GET", headers });
        if (!response.ok) {
          return failed(action, `Web Reader could not fetch ${url} (HTTP ${response.status}).`);
        }
        const body = (await response.text().catch(() => "")).trim();
        if (!body) {
          return failed(action, `Web Reader returned no readable content for ${url}.`);
        }
        const truncated = body.length > MAX_CHARS;
        const content = truncated ? `${body.slice(0, MAX_CHARS)}\n…[truncated ${body.length - MAX_CHARS} chars]` : body;
        return {
          adapter: ADAPTER_NAME,
          action,
          status: "completed",
          summary: `Read ${url} (${body.length} chars as markdown):\n\n${content}`,
        };
      } catch (err: unknown) {
        return failed(action, `Web Reader request errored: ${(err as Error).message}`);
      }
    },
    async dryRun(action, payload) {
      const url = typeof payload.url === "string" ? payload.url : "(url)";
      return {
        adapter: ADAPTER_NAME,
        action,
        status: "mocked",
        summary: `Web Reader dry-run: Trent would read ${url} as clean markdown.`,
      };
    },
  };
}
