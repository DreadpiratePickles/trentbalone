import { resolveCredentialEnv, scrubSecrets } from "@/lib/credential-boundary";
import type {
  AdSetInput,
  BudgetInput,
  CampaignControlInput,
  CampaignControlResult,
  CampaignDraftInput,
  ConversionEventInput,
  ConversionSourceInput,
  CreativeInput,
  InsightsInput,
  MarketingPlatformAdapter,
  PlatformAdSet,
  PlatformCampaignDraft,
  PlatformConversionEventResult,
  PlatformConversionSource,
  PlatformCreative,
  PlatformInsights,
} from "@/lib/marketing/platform-adapter";

type GraphFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

type MetaAdapterDeps = {
  graphFetch?: GraphFetch;
  graphVersion?: string;
};

const META_CAPABILITIES = {
  campaignDrafts: true,
  conversionSource: false,
  serverEvents: false,
  insights: true,
  budgetUpdates: true,
  pauseCampaigns: true,
};

export class MetaLiveOperationUnsupportedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented for live Meta Graph mode`);
    this.name = "MetaLiveOperationUnsupportedError";
  }
}

export type MetaPlatformErrorCode =
  | "expired_token"
  | "rate_limited"
  | "rejected_ad_creative"
  | "partial_publication"
  | "provider_error";

export class MetaPlatformApiError extends Error {
  public readonly platform = "meta";

  constructor(
    public readonly operation: string,
    public readonly code: MetaPlatformErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Meta Graph ${operation} failed: ${message}`);
    this.name = "MetaPlatformApiError";
  }
}

export class MetaGraphResponseError extends Error {
  public readonly platform = "meta";
  public readonly code = "partial_publication";

  constructor(operation: string, field: string) {
    super(`Meta Graph ${operation} response missing ${field}`);
    this.name = "MetaGraphResponseError";
    this.operation = operation;
  }

  public readonly operation: string;
}

export function createMetaAdapter(deps: MetaAdapterDeps = {}): MarketingPlatformAdapter {
  const graphFetch = deps.graphFetch ?? (fetch as unknown as GraphFetch);
  const graphVersion = deps.graphVersion ?? "v20.0";

  async function getToken(companyId: string) {
    const env = await resolveCredentialEnv(companyId, ["Meta"]);
    return { token: env.META_ACCESS_TOKEN, env };
  }

  async function callGraph<T>(
    operation: string,
    companyId: string,
    path: string,
    init: RequestInit,
    secrets: Record<string, string>
  ): Promise<T> {
    const url = `https://graph.facebook.com/${graphVersion}${path}`;
    try {
      const res = await graphFetch(url, init);
      if (!res.ok) {
        const body = await res.text();
        throw classifyGraphError(operation, res.status, body, secrets, res.headers?.get("retry-after"));
      }
      return await res.json() as T;
    } catch (err) {
      if (err instanceof MetaPlatformApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(scrubSecrets(message, secrets));
    }
  }

  return {
    platform: "meta",
    capabilities: META_CAPABILITIES,

    async createCampaignDraft(input: CampaignDraftInput): Promise<PlatformCampaignDraft> {
      const externalAccountId = requireExternalAccountId(input.externalAccountId);
      const { token, env } = await getToken(input.companyId);
      if (!token) {
        return {
          platform: "meta",
          externalCampaignId: sandboxRef("campaign", input.companyId, input.marketingAccountId, input.name),
          status: "draft",
        };
      }

      const body = new URLSearchParams({
        name: input.name,
        objective: input.objective,
        status: "PAUSED",
        special_ad_categories: "[]",
      });
      const data = await callGraph<{ id?: string }>(
        "createCampaignDraft",
        input.companyId,
        `/${normalizeAdAccount(externalAccountId)}/campaigns`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
        env
      );

      return {
        platform: "meta",
        externalCampaignId: requireGraphId(data, "createCampaignDraft"),
        status: "draft",
      };
    },

    async createAdSet(input: AdSetInput): Promise<PlatformAdSet> {
      const externalAccountId = requireExternalAccountId(input.externalAccountId);
      const { token, env } = await getToken(input.companyId);
      if (!token) {
        return {
          platform: "meta",
          externalAdSetId: sandboxRef("adset", input.companyId, input.marketingAccountId, input.name),
          status: "draft",
        };
      }
      const body = new URLSearchParams({
        name: input.name,
        campaign_id: input.externalCampaignId,
        daily_budget: String(input.dailyBudgetCents),
        billing_event: "IMPRESSIONS",
        optimization_goal: objectiveToOptimizationGoal(input.objective),
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: input.audienceRef && input.audienceRef.trim() ? input.audienceRef : JSON.stringify(defaultTargeting()),
        status: "PAUSED",
      });
      const data = await callGraph<{ id?: string }>(
        "createAdSet",
        input.companyId,
        `/${normalizeAdAccount(externalAccountId)}/adsets`,
        graphPost(token, body),
        env,
      );
      return {
        platform: "meta",
        externalAdSetId: requireGraphId(data, "createAdSet"),
        status: "draft",
      };
    },

    async createCreative(input: CreativeInput): Promise<PlatformCreative> {
      const externalAccountId = requireExternalAccountId(input.externalAccountId);
      const { token, env } = await getToken(input.companyId);
      if (!token) {
        return {
          platform: "meta",
          externalCreativeId: sandboxRef("creative", input.companyId, input.marketingAccountId, input.headline),
          status: "draft",
        };
      }
      const body = new URLSearchParams({
        name: input.headline,
        object_story_spec: JSON.stringify({
          link_data: {
            message: input.primaryText,
            name: input.headline,
            link: input.assetUrl ?? "https://trent.app",
            call_to_action: {
              type: normalizeCta(input.cta),
              value: { link: input.assetUrl ?? "https://trent.app" },
            },
          },
        }),
      });
      const data = await callGraph<{ id?: string }>(
        "createCreative",
        input.companyId,
        `/${normalizeAdAccount(externalAccountId)}/adcreatives`,
        graphPost(token, body),
        env,
      );
      return {
        platform: "meta",
        externalCreativeId: requireGraphId(data, "createCreative"),
        status: "draft",
      };
    },

    async ensureConversionSource(input: ConversionSourceInput): Promise<PlatformConversionSource> {
      const { token } = await getToken(input.companyId);
      if (token) throw liveUnsupported("ensureConversionSource");
      return {
        platform: "meta",
        externalConversionSourceId: sandboxRef("pixel", input.companyId, input.marketingAccountId, input.name ?? "pixel"),
        status: "sandbox",
      };
    },

    async sendConversionEvent(input: ConversionEventInput): Promise<PlatformConversionEventResult> {
      const { token } = await getToken(input.companyId);
      if (token) throw liveUnsupported("sendConversionEvent");
      return {
        platform: "meta",
        eventId: input.eventId,
        delivered: Boolean(token),
        status: "sandbox",
      };
    },

    async fetchInsights(input: InsightsInput): Promise<PlatformInsights> {
      const { token, env } = await getToken(input.companyId);
      if (token) {
        const params = new URLSearchParams({
          fields: "impressions,clicks,spend,actions",
        });
        if (input.since || input.until) {
          params.set("time_range", JSON.stringify({
            since: input.since,
            until: input.until,
          }));
        }
        const data = await callGraph<{ data?: MetaInsightsRow[] }>(
          "fetchInsights",
          input.companyId,
          `/${encodeURIComponent(input.externalCampaignId)}/insights?${params.toString()}`,
          { method: "GET", headers: { Authorization: `Bearer ${token}` } },
          env,
        );
        return insightsFromGraph(data.data?.[0]);
      }
      return { platform: "meta", impressions: 0, clicks: 0, spendCents: 0, conversions: 0 };
    },

    async pauseCampaign(input: CampaignControlInput): Promise<CampaignControlResult> {
      const { token, env } = await getToken(input.companyId);
      if (token) {
        await callGraph<Record<string, unknown>>(
          "pauseCampaign",
          input.companyId,
          `/${encodeURIComponent(input.externalCampaignId)}`,
          graphPost(token, new URLSearchParams({ status: "PAUSED" })),
          env,
        );
        return {
          platform: "meta",
          externalCampaignId: input.externalCampaignId,
          status: "paused",
        };
      }
      return {
        platform: "meta",
        externalCampaignId: input.externalCampaignId,
        status: "sandbox",
      };
    },

    async setBudget(input: BudgetInput): Promise<CampaignControlResult> {
      const { token, env } = await getToken(input.companyId);
      if (token) {
        await callGraph<Record<string, unknown>>(
          "setBudget",
          input.companyId,
          `/${encodeURIComponent(input.externalCampaignId)}`,
          graphPost(token, new URLSearchParams({ daily_budget: String(input.dailyBudgetCents) })),
          env,
        );
        return {
          platform: "meta",
          externalCampaignId: input.externalCampaignId,
          status: "budget_updated",
        };
      }
      return {
        platform: "meta",
        externalCampaignId: input.externalCampaignId,
        status: "sandbox",
      };
    },
  };
}

type MetaInsightsRow = {
  impressions?: string;
  clicks?: string;
  spend?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
};

function liveUnsupported(operation: string) {
  return new MetaLiveOperationUnsupportedError(operation);
}

function requireGraphId(data: { id?: string }, operation: string) {
  if (!data.id) throw new MetaGraphResponseError(operation, "id");
  return data.id;
}

function classifyGraphError(
  operation: string,
  status: number,
  body: string,
  secrets: Record<string, string>,
  retryAfter: string | null | undefined,
) {
  const scrubbed = scrubSecrets(body, secrets);
  if (status === 401 || /expired|invalid token|oauth/i.test(scrubbed)) {
    return new MetaPlatformApiError(operation, "expired_token", scrubbed);
  }
  if (status === 429) {
    const retry = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    return new MetaPlatformApiError(
      operation,
      "rate_limited",
      scrubbed,
      Number.isFinite(retry) ? retry : undefined,
    );
  }
  if ((status === 400 || status === 422) && (operation === "createCreative" || /creative|policy|rejected/i.test(scrubbed))) {
    return new MetaPlatformApiError(operation, "rejected_ad_creative", scrubbed);
  }
  return new MetaPlatformApiError(operation, "provider_error", `HTTP ${status}: ${scrubbed}`);
}

function graphPost(token: string, body: URLSearchParams): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  };
}

function defaultTargeting() {
  return { geo_locations: { countries: ["US"] } };
}

function objectiveToOptimizationGoal(objective: string) {
  const normalized = objective.toUpperCase();
  if (normalized.includes("LEAD")) return "LEAD_GENERATION";
  if (normalized.includes("CONVERSION") || normalized.includes("SALE")) return "OFFSITE_CONVERSIONS";
  if (normalized.includes("TRAFFIC")) return "LINK_CLICKS";
  return "REACH";
}

function normalizeCta(cta: string | undefined) {
  const normalized = cta?.trim().toUpperCase().replace(/\s+/g, "_");
  if (normalized === "SIGN_UP" || normalized === "SUBSCRIBE" || normalized === "BOOK_TRAVEL") return normalized;
  if (normalized === "BOOK_DEMO" || normalized === "GET_STARTED") return "SIGN_UP";
  return "LEARN_MORE";
}

function insightsFromGraph(row: MetaInsightsRow | undefined): PlatformInsights {
  return {
    platform: "meta",
    impressions: integerFrom(row?.impressions),
    clicks: integerFrom(row?.clicks),
    spendCents: Math.round(numberFrom(row?.spend) * 100),
    conversions: conversionsFromActions(row?.actions ?? []),
  };
}

function integerFrom(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function numberFrom(value: string | undefined) {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function conversionsFromActions(actions: Array<{ action_type?: string; value?: string }>) {
  return actions
    .filter((action) => /lead|purchase|subscribe|complete_registration|conversion/i.test(action.action_type ?? ""))
    .reduce((sum, action) => sum + integerFrom(action.value), 0);
}

function requireExternalAccountId(value: string) {
  const externalAccountId = value.trim();
  if (!externalAccountId) throw new Error("externalAccountId is required");
  return externalAccountId;
}

function sandboxRef(kind: string, companyId: string, marketingAccountId: string, name: string) {
  return `sandbox_meta_${kind}_${companyId}_${marketingAccountId}_${slugify(name)}`;
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "draft";
}

function normalizeAdAccount(externalAccountId: string) {
  return externalAccountId.startsWith("act_") ? externalAccountId : `act_${externalAccountId}`;
}
