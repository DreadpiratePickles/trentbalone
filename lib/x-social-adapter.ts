import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type XSocialAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

export type XTweetPayloadInput = {
  text?: unknown;
  madeWithAi?: unknown;
  quoteTweetId?: unknown;
  replyToTweetId?: unknown;
};

const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const APPROVAL_ACTION_RE = /\b(publish|post|tweet|send|reply)\b/i;

export function createXSocialAdapter(options: XSocialAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured = Boolean(xUserAccessToken(env));

  return {
    name: "X",
    scopes: ["x:post:create", "x:tweet:publish", "social:publish"],
    availability: configured ? "real" : "unavailable",
    async healthCheck() {
      return xUserAccessToken(env) ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return APPROVAL_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      const token = xUserAccessToken(env);
      if (!token) {
        return failed(action, "X is not configured. Set X_USER_ACCESS_TOKEN from an OAuth 2.0 user-context flow before agents can publish real posts.");
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

      try {
        const response = await fetchImpl(X_CREATE_POST_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(tweet),
        });
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
