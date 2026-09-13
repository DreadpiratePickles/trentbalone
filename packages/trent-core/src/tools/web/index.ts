/**
 * The `web` toolset: `web_search` (Tavily) and `web_extract` (Jina Reader) with Hermes's names
 * and schemas, wrapping the EXISTING adapters in `apps/web/lib` rather than re-implementing them.
 *
 * What the wrapper adds:
 *  - every request goes through Trent's EgressProxy (CONNECT + TLS interception), so a provider
 *    host that is not in `intercept_domains` is refused at the tunnel and the seat sees the 403;
 *  - Hermes's `url_safety` floors on every target URL, before any socket opens, and on redirects;
 *  - a full-length body capture, because the wrapped reader clips at 8,000 chars and Hermes's
 *    contract is 15,000 with a 75/25 head/tail split and the whole text spilled to a file.
 */
import { createWebSearchAdapter, parseTavilyResults } from "@/lib/web-search-adapter";
import { createWebReaderAdapter } from "@/lib/web-reader-adapter";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { fitSummary, headTail, spill } from "../spillover.js";
import { intArg, parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { createEgressFetch, type EgressClientOptions, type FetchLike } from "./proxied-fetch.js";
import { checkUrlSafety, type LookupFn } from "./url-safety.js";
import {
  WEB_EXTRACT_DEFAULT_CHARS,
  WEB_EXTRACT_MAX_URLS,
  WEB_EXTRACT_MIN_CHARS,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  WEB_TOOL_SCHEMAS,
  renderToolInstructions,
} from "./schemas.js";

export { WEB_TOOL_SCHEMAS, renderToolInstructions, type ToolSchema } from "./schemas.js";
export { checkUrlSafety } from "./url-safety.js";
export { createEgressFetch, EgressRefusedError, RedirectBlockedError } from "./proxied-fetch.js";

export const WEB_ADAPTER_NAME = "web";
const HEAD_RATIO = 0.75;
const SNIPPET_CHARS = 400;
const SPECS: readonly ToolSpec[] = [
  { name: "web_search", primary: "query", signature: ["query"] },
  { name: "web_extract", primary: "urls", signature: ["urls"] },
];
const ROUTING_TEXT =
  "web search the internet, look up, research, find sources, fetch a url, read a web page, " +
  "extract page text, browse documentation online";

export interface WebToolsOptions {
  /** `<profile>` directory; spillover lands in `<profile>/cache/spillover`. */
  profileDir: string;
  /**
   * TAVILY_API_KEY / JINA_API_KEY. Under the egress proxy these hold the opaque broker token,
   * never the real key - the proxy swaps it at the boundary.
   */
  env?: NodeJS.ProcessEnv;
  /** Route every request through the egress proxy. Required unless `fetchImpl` is given. */
  egress?: Omit<EgressClientOptions, "lookup">;
  /** Direct transport for tests only; bypasses the proxy. */
  fetchImpl?: FetchLike;
  /** Injectable DNS resolver for the SSRF floors. */
  lookup?: LookupFn;
}

interface Capture {
  bodies: Map<string, string>;
  json: Map<string, unknown>;
}

/** Wrap a transport so the full response body is retained per request URL. */
function capturing(base: FetchLike, capture: Capture, searchLimit: () => number): FetchLike {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const key = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let nextInit = init;
    if (key.includes("api.tavily.com") && typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        parsed.max_results = searchLimit();
        nextInit = { ...init, body: JSON.stringify(parsed) };
      } catch {
        // Leave the body alone; the wrapped adapter's own clamp applies.
      }
    }
    const res = await base(input, nextInit);
    const text = await res.clone().text();
    capture.bodies.set(key, text);
    try {
      capture.json.set(key, JSON.parse(text));
    } catch {
      // Not JSON; the text capture is what the reader path needs.
    }
    return res;
  };
  return impl as FetchLike;
}

export function createWebToolsAdapter(options: WebToolsOptions): TrentToolAdapter {
  const env = options.env ?? {};
  const capture: Capture = { bodies: new Map(), json: new Map() };
  let currentLimit = WEB_SEARCH_DEFAULT_LIMIT;
  const transport: FetchLike | null = options.fetchImpl
    ? options.fetchImpl
    : options.egress
      ? createEgressFetch({ ...options.egress, lookup: options.lookup })
      : null;
  const fetchImpl = transport ? capturing(transport, capture, () => currentLimit) : null;
  const search = createWebSearchAdapter({ env, ...(fetchImpl ? { fetchImpl } : {}) });
  const reader = createWebReaderAdapter({ env, ...(fetchImpl ? { fetchImpl } : {}) });

  const fail = (action: string, summary: string): ToolCallRecord =>
    record(WEB_ADAPTER_NAME, action, "failed", summary);
  const done = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    record(WEB_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "web"));

  async function webSearch(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const query = stringArg(args, "query")?.trim();
    if (!query) return fail(action, "web_search requires a non-empty \"query\".");
    currentLimit = intArg(args.limit, WEB_SEARCH_DEFAULT_LIMIT, 1, WEB_SEARCH_MAX_LIMIT);
    const inner = await search.execute("search", { query, maxResults: currentLimit });
    if (inner.status !== "completed") return record(WEB_ADAPTER_NAME, action, inner.status, inner.summary);

    const raw = [...capture.json.entries()].find(([k]) => k.includes("api.tavily.com"))?.[1];
    if (raw === undefined) return done(action, "completed", inner.summary);
    const { answer, results } = parseTavilyResults(raw);
    const lines: string[] = [];
    if (answer) lines.push(`Answer: ${answer}`, "");
    lines.push(`${results.length} result(s) for "${query}":`);
    results.slice(0, currentLimit).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`, `   ${r.url}`);
      if (r.content) lines.push(`   ${r.content.slice(0, SNIPPET_CHARS)}`);
    });
    return done(action, "completed", lines.join("\n"));
  }

  async function extractOne(url: string, charLimit: number): Promise<{ status: ToolCallRecord["status"]; text: string }> {
    const verdict = await checkUrlSafety(url, { lookup: options.lookup });
    if (!verdict.ok) return { status: "blocked", text: `${url}: blocked - ${verdict.reason}` };

    const inner = await reader.execute("extract", { url });
    if (inner.status !== "completed") return { status: inner.status, text: `${url}: ${inner.summary}` };

    const full = capture.bodies.get(`https://r.jina.ai/${url}`)?.trim() ?? inner.summary;
    if (full.length <= charLimit) return { status: "completed", text: `## ${url} (${full.length} chars)\n${full}` };

    const file = spill(options.profileDir, "web_extract", full);
    const clipped = headTail(full, charLimit, HEAD_RATIO);
    return {
      status: "completed",
      text:
        `## ${url} (${full.length} chars; showing ${charLimit}. Full text saved to ${file} - ` +
        `use read_file with an offset to page through it.)\n${clipped}`,
    };
  }

  async function webExtract(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : [];
    if (!urls.length) return fail(action, "web_extract requires \"urls\": a non-empty array of http(s) URLs.");
    if (urls.length > WEB_EXTRACT_MAX_URLS) {
      return fail(action, `web_extract accepts at most ${WEB_EXTRACT_MAX_URLS} urls; got ${urls.length}.`);
    }
    const rawLimit = args.char_limit;
    if (rawLimit !== undefined && (typeof rawLimit !== "number" || rawLimit < WEB_EXTRACT_MIN_CHARS)) {
      return fail(action, `web_extract char_limit must be an integer of at least ${WEB_EXTRACT_MIN_CHARS}.`);
    }
    const charLimit = intArg(args.char_limit, WEB_EXTRACT_DEFAULT_CHARS, WEB_EXTRACT_MIN_CHARS, Number.MAX_SAFE_INTEGER);
    if (!fetchImpl) return fail(action, "web toolset has no transport: configure the egress proxy first.");

    const parts: string[] = [];
    let status: ToolCallRecord["status"] = "completed";
    for (const url of urls) {
      const one = await extractOne(url, charLimit);
      parts.push(one.text);
      if (one.status !== "completed" && status === "completed") status = one.status;
      if (one.status === "blocked") status = "blocked";
    }
    return done(action, status, parts.join("\n\n"));
  }

  return {
    name: WEB_ADAPTER_NAME,
    scopes: [WEB_ADAPTER_NAME, "web_search", "web_extract", "web:search", "web:extract"],
    availability: "real",
    instructions: renderToolInstructions(WEB_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: () => search.healthCheck(),
    estimateCost: () => 0,
    requiresApproval: () => false,
    async execute(action) {
      const { tool, args, error } = parseAction(action, SPECS);
      if (error) return fail(action, error);
      if (tool === "web_search") return webSearch(action, args);
      return webExtract(action, args);
    },
    async dryRun(action) {
      return record(WEB_ADAPTER_NAME, action, "mocked", `web dry-run: would perform "${action}" (read-only).`);
    },
    async cleanup() {
      capture.bodies.clear();
      capture.json.clear();
    },
  };
}
