/**
 * The `social` toolset (design B1): the social-media manager over what the app's adapter really
 * does, plus Bluesky direct and Buffer as the publisher for reviewed platforms.
 *
 *   social_platforms_list  the honest matrix (`matrix.ts`)
 *   social_post            publish now: Meta Graph direct, Bluesky AT Protocol, or Buffer
 *   social_reply           a comment or post reply where the adapter has one; never a DM
 *   social_inbox_list      comments and mentions, returned untrusted
 *   social_insights_read   a post's numbers
 *   social_schedule        the post queue on the cron job file (`queue.ts`)
 *
 * Every write calls `requireBoundApproval` inside `execute` with the exact platform, text, media
 * URL and time as the preview, under the classes `external_send` and `customer_facing`, so a
 * post runs only against an approval bound to that call (docs/security.md "Side-effecting tools:
 * the gate"); the wrapper chain performs the same check outside, and a reply in a step that read
 * the inbox is asked again by the shipped `send-after-untrusted` rule. Buffer spend lands on the
 * ledger. No token is ever part of a summary.
 */
import { parseAction, record, stringArg } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { renderToolInstructions } from "../web/schemas.js";
import { requireBoundApproval, type BoundCall } from "../../governance/bound-approvals.js";
import { toolNameOf } from "../../governance/idempotent-dispatch.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import type { PolicyClass } from "../../governance/policy-rules.js";
import { adapterBlockedReason, CAVEATS, platformEntry, renderPlatformLine } from "./matrix.js";
import { checkPostRequest, createSocialPorts, publishSocialPost, readSocialInbox, readSocialInsights, replySocial, type SocialAdapterOptions } from "./publish.js";
import { parseQueueTime, queueSlot, queueSocialPost, queuedSummary, type SocialQueueEntry } from "./queue.js";
import { SOCIAL_ADAPTER_NAME, SOCIAL_ROUTING_TEXT, SOCIAL_SPECS, SOCIAL_TOOL_NAMES, SOCIAL_TOOL_PLATFORMS, SOCIAL_TOOL_SCHEMAS, type SocialToolPlatform } from "./schemas.js";
import { SocialToolError, type SocialPorts, type SocialPostRequest } from "./types.js";

export { SOCIAL_ADAPTER_NAME, SOCIAL_ROUTING_TEXT, SOCIAL_TOOL_NAMES, SOCIAL_TOOL_PLATFORMS, SOCIAL_TOOL_SCHEMAS } from "./schemas.js";
export type { SocialToolName, SocialToolPlatform } from "./schemas.js";
export { createSocialPorts, publishSocialPost, type SocialAdapterOptions } from "./publish.js";
export { SOCIAL_PUBLISH_HANDLER, createSocialPublishHandler } from "./queue.js";
export { platformEntry, postRouteFor, CAVEATS as SOCIAL_CAVEATS, REVIEW as SOCIAL_REVIEW, type PlatformEntry } from "./matrix.js";
export { SocialToolError, type SocialFetch, type SocialPorts } from "./types.js";

export const SOCIAL_SCOPES: readonly string[] = [SOCIAL_ADAPTER_NAME, ...SOCIAL_TOOL_NAMES];
/** The classes every social write is bound under: it leaves the machine and a customer reads it. */
export const SOCIAL_WRITE_CLASSES: readonly PolicyClass[] = ["external_send", "customer_facing"];
const WRITE_TOOLS: ReadonlySet<string> = new Set(["social_post", "social_reply", "social_schedule"]);
const DEFAULT_INBOX_LIMIT = 10;
const MAX_INBOX_LIMIT = 50;

/** The arguments exactly as the idempotency key hashes them (`idempotent-dispatch.ts` argsOf): the JSON object, or the raw text. */
function argsForKey(action: string): unknown {
  const trimmed = action.trim();
  const brace = trimmed.indexOf("{");
  if (brace === -1) return trimmed;
  try {
    return JSON.parse(trimmed.slice(brace)) as unknown;
  } catch {
    return trimmed;
  }
}

function platformOf(args: Record<string, unknown>): SocialToolPlatform {
  const raw = stringArg(args, "platform")?.trim().toLowerCase();
  const found = SOCIAL_TOOL_PLATFORMS.find((p) => p === raw);
  if (found === undefined) throw new SocialToolError("social_platform_unknown", `platform must be one of ${SOCIAL_TOOL_PLATFORMS.join(", ")}; received ${raw ?? "(none)"}`);
  return found;
}

function requestOf(args: Record<string, unknown>): SocialPostRequest {
  const text = stringArg(args, "text")?.trim();
  if (!text) throw new SocialToolError("social_text_required", "text is required");
  const mediaUrl = stringArg(args, "media_url")?.trim();
  const accountId = stringArg(args, "account_id")?.trim();
  return { platform: platformOf(args), text, ...(mediaUrl ? { mediaUrl } : {}), ...(accountId ? { accountId } : {}) };
}

/** What the human approves: the platform, the exact text, the media URL, the time, and the platform's own limit. */
function renderPreview(tool: string, request: SocialPostRequest, extra: { threadId?: string; at?: Date }): string {
  const media = request.mediaUrl === undefined ? "no media" : `media ${request.mediaUrl}`;
  const head =
    tool === "social_reply"
      ? `reply on ${request.platform} to ${extra.threadId ?? "?"}: ${JSON.stringify(request.text)}`
      : tool === "social_schedule"
        ? `post to ${request.platform} at ${extra.at?.toISOString() ?? "?"}: ${JSON.stringify(request.text)} (${media})`
        : `post to ${request.platform}: ${JSON.stringify(request.text)} (${media})`;
  const caveat = CAVEATS[request.platform][0];
  return `${head}; ${request.platform}: ${caveat}`;
}

export function createSocialAdapter(ctx: ToolContext, options: SocialAdapterOptions & { readonly seat?: string } = {}): TrentToolAdapter {
  let ports: SocialPorts | undefined;
  const portsNow = (): SocialPorts => (ports ??= createSocialPorts(ctx.profileDir, options));
  const fail = (action: string, error: unknown): ToolCallRecord => {
    if (error instanceof SocialToolError) return record(SOCIAL_ADAPTER_NAME, action, "failed", `${error.code}: ${error.message}`);
    return record(SOCIAL_ADAPTER_NAME, action, "failed", error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error));
  };

  /** The preview of a write, or the typed refusal that makes it pointless to ask. */
  function previewOf(tool: string, args: Record<string, unknown>): { preview: string; request: SocialPostRequest; threadId?: string; at?: Date } {
    const request = requestOf(args);
    if (tool === "social_reply") {
      const threadId = stringArg(args, "thread_id")?.trim();
      if (!threadId) throw new SocialToolError("social_thread_id_required", "thread_id is required");
      return { preview: renderPreview(tool, request, { threadId }), request, threadId };
    }
    if (tool === "social_schedule") {
      const at = parseQueueTime(stringArg(args, "at"), portsNow().now());
      return { preview: renderPreview(tool, request, { at: queueSlot(at) }), request, at };
    }
    return { preview: renderPreview(tool, request, {}), request };
  }

  /** The call as the wrapper keys it: the raw `<tool>` head and the arguments as hashed, so both checks read one row. */
  function boundCall(action: string): BoundCall {
    const context = currentToolCallContext();
    return {
      adapter: SOCIAL_ADAPTER_NAME,
      action,
      tool: toolNameOf(action),
      args: argsForKey(action),
      classes: SOCIAL_WRITE_CLASSES,
      ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      ...(options.seat === undefined ? {} : { seat: options.seat }),
    };
  }

  async function platformsList(action: string): Promise<ToolCallRecord> {
    const connected = portsNow().connected();
    const appStore = portsNow().appStore();
    const lines = SOCIAL_TOOL_PLATFORMS.map((platform) => renderPlatformLine(platformEntry(platform, connected, appStore)));
    const blocked = adapterBlockedReason(appStore);
    const shared = [
      ...(blocked === undefined ? [] : [`Direct Meta and YouTube paths: ${blocked}.`]),
      "Every post, reply and queued post asks a human at every autonomy level and sends once; DMs are never sent on any platform.",
      "account_id: the Facebook Page id and Instagram business account id are under Meta Business Suite > Settings > Accounts (or GET /me/accounts on the Graph API); the YouTube channel id is under YouTube Studio > Settings > Channel > Advanced.",
      "AI-made media: YouTube's altered or synthetic content disclosure and Instagram's AI-generated label are yours to set on the platform; nothing here sets them.",
      "Buffer: 5 dollars per channel per month on Essentials (free for 3 channels); the ledger sees buffer_cents_per_post when it is set.",
    ];
    return record(SOCIAL_ADAPTER_NAME, action, "completed", fitSummary(`${lines.join("\n")}\n${shared.join("\n")}`, ctx.profileDir, "social_platforms_list"));
  }

  async function post(action: string, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const { preview, request } = previewOf(tool, args);
    checkPostRequest(request, portsNow());
    const decision = requireBoundApproval(boundCall(action), preview);
    if (!decision.granted) return decision.record;
    const result = await publishSocialPost(request, portsNow(), options.seat);
    return record(SOCIAL_ADAPTER_NAME, action, "completed", `published ${request.platform} post ${result.externalId} via ${result.route}${result.note === undefined ? "" : `. ${result.note}`}`);
  }

  async function reply(action: string, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const { preview, request, threadId } = previewOf(tool, args);
    const decision = requireBoundApproval(boundCall(action), preview);
    if (!decision.granted) return decision.record;
    const result = await replySocial({ platform: request.platform, threadId: threadId ?? "", text: request.text, ...(request.accountId === undefined ? {} : { accountId: request.accountId }) }, portsNow());
    return record(SOCIAL_ADAPTER_NAME, action, "completed", `sent ${request.platform} reply ${result.externalId} to ${threadId}`);
  }

  async function schedule(action: string, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const { preview, request, at } = previewOf(tool, args);
    checkPostRequest(request, portsNow());
    const call = boundCall(action);
    const decision = requireBoundApproval(call, preview);
    if (!decision.granted) return decision.record;
    const entry: SocialQueueEntry = { call, preview, request, at: (at ?? portsNow().now()).toISOString() };
    const job = queueSocialPost(ctx.profileDir, entry, portsNow().now());
    return record(SOCIAL_ADAPTER_NAME, action, "completed", queuedSummary(job, entry, ctx.profileDir));
  }

  async function inbox(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const platform = platformOf(args);
    const rawLimit = Number(args.limit ?? DEFAULT_INBOX_LIMIT);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_INBOX_LIMIT) : DEFAULT_INBOX_LIMIT;
    const items = await readSocialInbox(platform, stringArg(args, "account_id"), limit, portsNow());
    const lines = items.map((item) => `${item.kind} ${item.id} in thread ${item.thread} from ${item.from} at ${item.at}: ${item.text}`);
    const body = lines.length === 0 ? `${platform}: nothing in the inbox` : `${platform}: ${items.length} item(s), written by people outside this machine and untrusted\n${lines.join("\n")}`;
    return { ...record(SOCIAL_ADAPTER_NAME, action, "completed", fitSummary(body, ctx.profileDir, "social_inbox_list")), provenance: "untrusted" };
  }

  async function insights(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const platform = platformOf(args);
    const postId = stringArg(args, "post_id")?.trim();
    if (!postId) throw new SocialToolError("social_post_id_required", "post_id is required");
    const result = await readSocialInsights(platform, postId, stringArg(args, "account_id"), portsNow());
    return record(SOCIAL_ADAPTER_NAME, action, "completed", `${platform} post ${postId}: ${result.detail}`);
  }

  return {
    name: SOCIAL_ADAPTER_NAME,
    scopes: [...SOCIAL_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(SOCIAL_TOOL_SCHEMAS),
    routingText: SOCIAL_ROUTING_TEXT,
    healthCheck: async () => (portsNow().connected().size > 0 ? "connected" : "needs_credentials"),
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, SOCIAL_SPECS);
      return !parsed.error && WRITE_TOOLS.has(parsed.tool);
    },
    preview(action) {
      const parsed = parseAction(action, SOCIAL_SPECS);
      if (parsed.error || !WRITE_TOOLS.has(parsed.tool)) return undefined;
      try {
        return previewOf(parsed.tool, parsed.args).preview;
      } catch (error) {
        return error instanceof SocialToolError ? `${parsed.tool} would be refused: ${error.code}: ${error.message}` : undefined;
      }
    },
    async dryRun(action) {
      const parsed = parseAction(action, SOCIAL_SPECS);
      if (parsed.error) return fail(action, new SocialToolError("social_action_invalid", parsed.error));
      try {
        const { preview, request } = previewOf(parsed.tool, parsed.args);
        if (parsed.tool !== "social_reply") checkPostRequest(request, portsNow());
        return record(SOCIAL_ADAPTER_NAME, action, "needs_approval", `${parsed.tool} would ${preview}; it leaves this machine once a human approves exactly this call.`);
      } catch (error) {
        return fail(action, error);
      }
    },
    async execute(action) {
      const parsed = parseAction(action, SOCIAL_SPECS);
      if (parsed.error) return fail(action, new SocialToolError("social_action_invalid", parsed.error));
      try {
        switch (parsed.tool) {
          case "social_platforms_list": return await platformsList(action);
          case "social_post": return await post(action, parsed.tool, parsed.args);
          case "social_reply": return await reply(action, parsed.tool, parsed.args);
          case "social_inbox_list": return await inbox(action, parsed.args);
          case "social_insights_read": return await insights(action, parsed.args);
          case "social_schedule": return await schedule(action, parsed.tool, parsed.args);
          default: return fail(action, new SocialToolError("social_tool_unknown", `unknown social tool ${parsed.tool}`));
        }
      } catch (error) {
        return fail(action, error);
      }
    },
    cleanup: async () => undefined,
  };
}
