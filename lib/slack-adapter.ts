import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";
import { logger } from "@/lib/logger";
import { resolveToolCredential, type ResolveToolCredentialDeps } from "@/lib/tool-credentials";

const REQUEST_TIMEOUT_MS = 15_000;
// Slack's chat.postMessage hard-rejects text beyond ~40k chars; clip below it.
const MAX_TEXT_CHARS = 39_000;

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type SlackAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  /** Injectable credential resolver deps (per-company ToolConnection lookup) for tests. */
  credentialDeps?: ResolveToolCredentialDeps;
};

export type SlackCredential = { botToken: string; defaultChannel?: string };

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

  // Per-company Slack workspace (encrypted ToolConnection) first, global env second.
  async function resolveCredential(companyId?: string): Promise<SlackCredential | undefined> {
    const { value } = await resolveToolCredential<SlackCredential>({
      companyId,
      provider: ADAPTER_NAME,
      deps: options.credentialDeps,
      envFallback: () => {
        const botToken = slackBotToken(env);
        if (!botToken) return undefined;
        const defaultChannel = slackDefaultChannel(env);
        return defaultChannel ? { botToken, defaultChannel } : { botToken };
      },
    });
    return value;
  }

  return {
    name: ADAPTER_NAME,
    scopes: ["slack:chat:write", "notifications", "workspace_updates"],
    availability: "real",
    async healthCheck(companyId?: string) {
      const cred = await resolveCredential(companyId);
      if (!cred?.botToken || !isHttpHeaderValueSafe(cred.botToken)) return "needs_credentials";
      try {
        const response = await fetchImpl(AUTH_TEST_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${cred.botToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      const companyId = typeof payload.companyId === "string" ? payload.companyId : undefined;
      const cred = await resolveCredential(companyId);
      if (!cred?.botToken) {
        return failed(action, "Slack is not configured. Connect a Slack workspace for this company or set SLACK_BOT_TOKEN.");
      }
      const token = cred.botToken;
      if (!isHttpHeaderValueSafe(token)) {
        return failed(action, malformedCredentialSummary(ADAPTER_NAME));
      }
      if (!POST_ACTIONS.some((word) => action.toLowerCase().includes(word))) {
        return failed(action, `Unsupported Slack action "${action}". Supported: ${POST_ACTIONS.join(", ")}.`);
      }

      const channel = typeof payload.channel === "string" && payload.channel.trim()
        ? payload.channel.trim()
        : cred.defaultChannel;
      if (!channel) {
        return failed(action, "Slack post requires a channel (payload.channel or a configured default channel).");
      }
      const rawText = messageText(payload);
      if (!rawText) {
        return failed(action, `Slack action "${action}" requires payload.text.`);
      }
      const text = rawText.length > MAX_TEXT_CHARS ? `${rawText.slice(0, MAX_TEXT_CHARS)}…` : rawText;

      try {
        logger.info({ adapter: ADAPTER_NAME, action, channel, chars: text.length }, "slack.post");
        const response = await fetchImpl(POST_MESSAGE_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ channel, text }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
