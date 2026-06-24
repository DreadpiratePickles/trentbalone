import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type SlackAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

const ADAPTER_NAME = "Slack";
const POST_MESSAGE_ENDPOINT = "https://slack.com/api/chat.postMessage";
const AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";
const POST_ACTIONS = ["post", "notify", "message", "send", "update"];

export function slackBotToken(env: EnvLike = process.env): string | undefined {
  const token = env.SLACK_BOT_TOKEN?.trim();
  return token ? token : undefined;
}

export function slackDefaultChannel(env: EnvLike = process.env): string | undefined {
  const channel = env.SLACK_DEFAULT_CHANNEL?.trim();
  return channel ? channel : undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: ADAPTER_NAME, action, status: "failed", summary };
}

function messageText(payload: Record<string, unknown>): string {
  for (const key of ["text", "message", "summary", "body"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Real Slack delivery via chat.postMessage — lets agents post operating
 * briefs, weekly reports, and approval requests into the founder's own
 * workspace ("where the work lands"). Posting to the company's configured
 * channel is the core feature, so it is NOT approval-gated; it spends no
 * money. Fails closed without SLACK_BOT_TOKEN rather than pretending to post.
 */
export function createSlackAdapter(options: SlackAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: ADAPTER_NAME,
    scopes: ["slack:chat:write", "notifications", "workspace_updates"],
    availability: "real",
    async healthCheck() {
      const token = slackBotToken(env);
      if (!token || !isHttpHeaderValueSafe(token)) return "needs_credentials";
      try {
        const response = await fetchImpl(AUTH_TEST_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return "needs_credentials";
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
        return data.ok === true ? "connected" : "needs_credentials";
      } catch {
        return "needs_credentials";
      }
    },
    estimateCost() {
      return 0;
    },
    requiresApproval() {
      // Posting to the founder's own workspace channel is the product, not a
      // risky external side effect — keep it frictionless.
      return false;
    },
    async execute(action, payload): Promise<ToolCallRecord> {
      const token = slackBotToken(env);
      if (!token) {
        return failed(action, "Slack is not configured. Set SLACK_BOT_TOKEN before agents can post to your workspace.");
      }
      if (!isHttpHeaderValueSafe(token)) {
        return failed(action, malformedCredentialSummary(ADAPTER_NAME));
      }
      if (!POST_ACTIONS.some((word) => action.toLowerCase().includes(word))) {
        return failed(action, `Unsupported Slack action "${action}". Supported: ${POST_ACTIONS.join(", ")}.`);
      }

      const channel = typeof payload.channel === "string" && payload.channel.trim()
        ? payload.channel.trim()
        : slackDefaultChannel(env);
      if (!channel) {
        return failed(action, "Slack post requires a channel (payload.channel or SLACK_DEFAULT_CHANNEL).");
      }
      const text = messageText(payload);
      if (!text) {
        return failed(action, `Slack action "${action}" requires payload.text.`);
      }

      try {
        const response = await fetchImpl(POST_MESSAGE_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel, text }),
        });
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
        if (!response.ok || data.ok !== true) {
          return failed(action, `Slack post failed: ${data.error ?? `HTTP ${response.status}`}.`);
        }
        return {
          adapter: ADAPTER_NAME,
          action,
          status: "completed",
          summary: `Posted to Slack ${channel}${data.ts ? ` (ts ${data.ts})` : ""}: "${text.slice(0, 80)}".`,
        };
      } catch (err: unknown) {
        return failed(action, `Slack request errored: ${(err as Error).message}`);
      }
    },
    async dryRun(action, payload) {
      const channel = typeof payload.channel === "string" ? payload.channel : (slackDefaultChannel(env) ?? "the default channel");
      return {
        adapter: ADAPTER_NAME,
        action,
        status: "mocked",
        summary: `Slack dry-run: Trent would post to ${channel}.`,
      };
    },
  };
}
