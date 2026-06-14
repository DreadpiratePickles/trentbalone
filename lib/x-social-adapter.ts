import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";
import { refreshXAccessToken, xRefreshConfigured, type XRefreshResult } from "@/lib/x-oauth";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type XSocialAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  /** Called with rotated tokens after a successful OAuth2 refresh (persist them). */
  onRefresh?: (tokens: XRefreshResult) => void;
};

export type XTweetPayloadInput = {
  text?: unknown;
  madeWithAi?: unknown;
  quoteTweetId?: unknown;
  replyToTweetId?: unknown;
};

const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const X_USER_ME_URL = "https://api.x.com/2/users/me";
const APPROVAL_ACTION_RE = /\b(publish|post|tweet|send|reply)\b/i;

export function createXSocialAdapter(options: XSocialAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Per-adapter cache of a refreshed access token (X tokens expire ~2h).
  let cached: { token: string; expiresAt: number } | undefined;

  async function refreshToken(): Promise<string | undefined> {
    if (!xRefreshConfigured(env)) return undefined;
    try {
      const refreshed = await refreshXAccessToken(env, fetchImpl);
      cached = { token: refreshed.accessToken, expiresAt: Date.now() + (refreshed.expiresIn ?? 7200) * 1000 };
      options.onRefresh?.(refreshed);
      return refreshed.accessToken;
    } catch {
      return undefined;
    }
  }

  /** Resolve a usable user-context token: cached → static → freshly refreshed. */
  async function resolveToken(forceRefresh = false): Promise<string | undefined> {
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (forceRefresh) return refreshToken();
    const staticToken = xUserAccessToken(env);
    if (staticToken && isHttpHeaderValueSafe(staticToken)) return staticToken;
    return refreshToken();
  }

  return {
    name: "X",
    scopes: ["x:post:create", "x:tweet:publish", "social:publish"],
    availability: "real",
    async healthCheck() {
      let token = await resolveToken();
      if (!token || !isHttpHeaderValueSafe(token)) return "needs_credentials";
      try {
        let response = await fetchImpl(X_USER_ME_URL, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        // A 401 on a static token can be cured by an OAuth2 refresh.
        if (!response.ok && response.status === 401 && xRefreshConfigured(env)) {
          token = await resolveToken(true);
          if (!token) return "needs_credentials";
          response = await fetchImpl(X_USER_ME_URL, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });
        }
        return response.ok ? "connected" : "needs_credentials";
      } catch {
        return "needs_credentials";
      }
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return APPROVAL_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      let token = await resolveToken();
      if (!token) {
        return failed(action, "X is not configured. Set X_USER_ACCESS_TOKEN (or X_CLIENT_ID/X_CLIENT_SECRET/X_REFRESH_TOKEN for OAuth2 refresh) before agents can publish real posts.");
      }
      if (!isHttpHeaderValueSafe(token)) {
        return failed(action, malformedCredentialSummary("X user access token"));
      }
      if (this.requiresApproval(action) && typeof payload.approvalId !== "string") {
        return {
          adapter: "X",
          action,
          status: "needs_approval",
          summary: `X action "${action}" requires approval before Trent publishes publicly.`,
        };
      }

      const tweet = buildXTweetPayload(payload);
      const validation = validateTweetPayload(tweet);
      if (validation) return failed(action, validation);

      const post = (bearer: string) => fetchImpl(X_CREATE_POST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(tweet),
      });

      try {
        let response = await post(token);
        // Refresh-and-retry once if the token had expired.
        if (!response.ok && response.status === 401 && xRefreshConfigured(env)) {
          const refreshedToken = await resolveToken(true);
          if (refreshedToken) {
            token = refreshedToken;
            response = await post(token);
          }
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          return failed(action, `X rejected post (${response.status}): ${xErrorMessage(body)}`);
        }
        const id = readString((body as { data?: Record<string, unknown> }).data?.id) || "unknown";
        return {
          adapter: "X",
          action,
          status: "completed",
          summary: `X accepted post ${id} for publication.`,
        };
      } catch (error) {
        return failed(action, `X publish failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "X",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: "X dry-run: Trent would publish through X API after approval.",
      };
    },
  };
}

export function buildXTweetPayload(input: XTweetPayloadInput) {
  const payload: Record<string, unknown> = {};
  const text = readString(input.text);
  if (text) payload.text = text;
  if (input.madeWithAi === true) payload.made_with_ai = true;

  const quoteTweetId = readString(input.quoteTweetId);
  if (quoteTweetId) payload.quote_tweet_id = quoteTweetId;

  const replyToTweetId = readString(input.replyToTweetId);
  if (replyToTweetId) payload.reply = { in_reply_to_tweet_id: replyToTweetId };

  return payload;
}

function validateTweetPayload(payload: Record<string, unknown>) {
  const text = readString(payload.text);
  if (!text) return "X publish requires payload.text.";
  if (text.length > 280) return "X publish text exceeds 280 characters.";
  return undefined;
}

function xUserAccessToken(env: EnvLike = process.env) {
  return firstNonEmpty(env.X_USER_ACCESS_TOKEN, env.TWITTER_USER_ACCESS_TOKEN);
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function xErrorMessage(body: unknown) {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    if (typeof record.title === "string") return record.title;
    if (Array.isArray(record.errors) && record.errors.length) {
      const first = record.errors[0];
      if (typeof first === "object" && first !== null) {
        const error = first as Record<string, unknown>;
        if (typeof error.detail === "string") return error.detail;
        if (typeof error.title === "string") return error.title;
      }
    }
  }
  return "unknown error";
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "X", action, status: "failed", summary };
}
