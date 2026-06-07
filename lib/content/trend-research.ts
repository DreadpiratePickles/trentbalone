import type { AgentMissionRun, Artifact, Document } from "@/lib/types";
import { store as appStore } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export type TrendResearchSignal = {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedAt?: string;
};

export type TrendResearchAdapter = {
  provider: "tavily" | "sandbox";
  search(input: TrendResearchSearchInput): Promise<TrendResearchSearchResult>;
};

export type TrendResearchSearchInput = {
  objective: string;
  query: string;
  platforms: string[];
  maxResults: number;
};

export type TrendResearchSearchResult = {
  query: string;
  answer?: string;
  signals: TrendResearchSignal[];
  usageCredits?: number;
  requestId?: string;
};

export type TrendResearchStore = {
  createArtifact(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Promise<Artifact>;
  createDocument(input: Omit<Document, "id" | "createdAt" | "version"> & { version?: number }): Promise<Document>;
};

export type MissionTrendResearchResult = {
  status: "completed" | "blocked";
  provider: TrendResearchAdapter["provider"] | "none";
  artifact: Artifact;
  document: Document;
  signalCount: number;
  blockers: string[];
};

type TavilyAdapterOptions = {
  apiKey: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
};

type TavilySearchResponse = {
  query?: string;
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
  usage?: { credits?: number };
  request_id?: string;
};

export async function persistMissionTrendResearch(input: {
  run: AgentMissionRun;
  platforms: string[];
  store?: TrendResearchStore;
  adapter?: TrendResearchAdapter;
  now?: () => string;
}): Promise<MissionTrendResearchResult> {
  const researchStore = input.store ?? appStore;
  const now = input.now ?? nowIso;
  const query = buildTrendResearchQuery(input.run.objective, input.platforms);
  const adapter = Object.prototype.hasOwnProperty.call(input, "adapter")
    ? input.adapter
    : defaultTrendResearchAdapter();
  const blockers: string[] = [];
  let provider: MissionTrendResearchResult["provider"] = adapter?.provider ?? "none";
  let search: TrendResearchSearchResult = { query, signals: [] };

  if (!adapter) {
    blockers.push("TAVILY_API_KEY is missing; live viral trend search did not run.");
  } else {
    try {
      search = await adapter.search({
        objective: input.run.objective,
        query,
        platforms: input.platforms,
        maxResults: 5,
      });
    } catch (error) {
      blockers.push(errorMessage(error));
    }
  }

  const recommendations = recommendContentAngles(input.run.objective, search.signals);
  const status = blockers.length ? "blocked" : "completed";
  const markdown = trendResearchMarkdown({
    run: input.run,
    provider,
    query,
    search,
    blockers,
    recommendations,
    generatedAt: now(),
  });
  const document = await researchStore.createDocument({
    companyId: input.run.companyId,
    type: "research",
    title: `Viral trend research ${input.run.startedAt.slice(0, 10)}`,
    content: markdown,
    source: `agent-mission-trend-research:${input.run.id}`,
    memoryTier: "semantic",
    validFrom: now(),
  });
  const artifact = await researchStore.createArtifact({
    companyId: input.run.companyId,
    type: "competitive_research",
    status: status === "completed" ? "ready" : "failed",
    title: "Viral trend research loop",
    summary: status === "completed"
      ? `${search.signals.length} sourced trend signals captured for analyst and content planning.`
      : `Trend source capture blocked: ${blockers.join("; ")}`,
    content: markdown,
    exportFormat: "markdown",
    storageKey: `agent-missions/${input.run.id}/loops/viral-trend-research.md`,
    createdByAgent: "analyst",
    provenance: {
      prompt: input.run.objective,
      sources: search.signals.map((signal) => signal.url),
      model: provider === "tavily" ? "tavily-search" : provider === "sandbox" ? "sandbox-trend-research" : "none",
      tokens: 0,
      costCents: provider === "tavily" ? (search.usageCredits ?? 1) : 0,
      generatedAt: now(),
    },
  });

  return {
    status,
    provider,
    artifact,
    document,
    signalCount: search.signals.length,
    blockers,
  };
}

export function createTavilyTrendResearchAdapter(options: TavilyAdapterOptions): TrendResearchAdapter {
  const endpoint = options.endpoint ?? "https://api.tavily.com/search";
  const fetchFn = options.fetchFn ?? fetch;
  return {
    provider: "tavily",
    async search(input) {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          search_depth: "basic",
          topic: "news",
          time_range: "week",
          max_results: input.maxResults,
          include_answer: "basic",
          include_raw_content: false,
          include_usage: true,
        }),
      });
      const body = await response.json().catch(() => ({})) as TavilySearchResponse & { error?: string; detail?: string };
      if (!response.ok) {
        const error = new Error(body.error ?? body.detail ?? `Tavily search failed with HTTP ${response.status}`);
        (error as Error & { code?: string; retryAfterSeconds?: number }).code = response.status === 429 ? "rate_limited" : "provider_error";
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = Number(retryAfter);
        throw error;
      }
      return {
        query: body.query ?? input.query,
        answer: body.answer,
        signals: normalizeSignals(body.results ?? []),
        usageCredits: body.usage?.credits,
        requestId: body.request_id,
      };
    },
  };
}

export function createSandboxTrendResearchAdapter(): TrendResearchAdapter {
  return {
    provider: "sandbox",
    async search(input) {
      const slug = slugify(input.objective);
      const platform = input.platforms[0] ?? "social";
      return {
        query: input.query,
        answer: "Sandbox trend pass found proof-led demos, operator teardown hooks, and comment-driven follow-up formats.",
        signals: [
          {
            title: "Proof-led workflow demos are earning saves",
            url: `https://trends.local/${slug}/proof-led-demos`,
            content: `Creators on ${platform} are packaging workflow demos as before/after transformations with a visible artifact at the end.`,
            score: 0.91,
          },
          {
            title: "Comment-to-content loops are converting questions into clips",
            url: `https://trends.local/${slug}/comment-to-content`,
            content: "High-performing posts answer one narrow buyer question, then invite DMs for the checklist or template.",
            score: 0.86,
          },
          {
            title: "Founder teardown formats are outperforming broad announcements",
            url: `https://trends.local/${slug}/founder-teardown`,
            content: "Audiences respond to tactical teardown narratives that show the mistake, the fix, and the measurable result.",
            score: 0.82,
          },
        ],
        usageCredits: 0,
        requestId: `sandbox_${slug}`,
      };
    },
  };
}

function defaultTrendResearchAdapter(): TrendResearchAdapter | undefined {
  const key = process.env.TAVILY_API_KEY;
  if (key?.trim()) return createTavilyTrendResearchAdapter({ apiKey: key.trim() });
  if (process.env.NODE_ENV === "test" || process.env.TREND_RESEARCH_MODE === "sandbox") {
    return createSandboxTrendResearchAdapter();
  }
  return undefined;
}

function buildTrendResearchQuery(objective: string, platforms: string[]) {
  const platformText = platforms.length ? platforms.join(", ") : "TikTok, Instagram, YouTube Shorts, LinkedIn, and X";
  return [
    "current viral content trends and campaign hooks",
    `platforms: ${platformText}`,
    `objective: ${objective}`,
    "include creator/operator examples, audience pains, comments/DM angles, ad creative cues, and what not to copy",
  ].join(" | ");
}

function normalizeSignals(results: NonNullable<TavilySearchResponse["results"]>): TrendResearchSignal[] {
  return results
    .filter((result) => result.title && result.url)
    .slice(0, 5)
    .map((result) => ({
      title: result.title ?? "Untitled trend source",
      url: result.url ?? "",
      content: result.content ?? "",
      score: result.score,
      publishedAt: result.published_date,
    }));
}

function recommendContentAngles(objective: string, signals: TrendResearchSignal[]) {
  const base = signals.slice(0, 3).map((signal) =>
    `Turn "${signal.title}" into a specific proof clip for: ${objective}`
  );
  return base.length ? base : [
    `Run a narrow proof demo tied to: ${objective}`,
    "Use comments and DMs as the next-iteration research source.",
  ];
}

function trendResearchMarkdown(input: {
  run: AgentMissionRun;
  provider: MissionTrendResearchResult["provider"];
  query: string;
  search: TrendResearchSearchResult;
  blockers: string[];
  recommendations: string[];
  generatedAt: string;
}) {
  return [
    "# Viral trend research loop",
    "",
    `Objective: ${input.run.objective}`,
    `Provider: ${input.provider}`,
    `Generated: ${input.generatedAt}`,
    `Query: ${input.query}`,
    "",
    "## Summary",
    input.search.answer ?? "No provider answer returned.",
    "",
    "## Sourced Signals",
    ...(input.search.signals.length
      ? input.search.signals.map((signal, index) => [
        `${index + 1}. [${signal.title}](${signal.url})`,
        `   - score: ${typeof signal.score === "number" ? signal.score.toFixed(2) : "n/a"}`,
        `   - signal: ${signal.content || "No snippet returned."}`,
      ].join("\n"))
      : ["- No sourced signals captured."]),
    "",
    "## Recommended Content Angles",
    ...input.recommendations.map((recommendation) => `- ${recommendation}`),
    "",
    "## Blockers",
    ...(input.blockers.length ? input.blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
  ].join("\n");
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "mission";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
