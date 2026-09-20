/**
 * `media_image` as the seat calls it: the prompt (typed, or the "Generation prompt" of a
 * `thumbnail-brief` file), the framing, the route and the price are settled first; then the
 * approval, bound to exactly this call (`governance/bound-approvals.ts`, gate G2), because an
 * image is metered external spend; then the one HTTP call; then the file under the workspace
 * and the ledger row (gate G5). The order matters: nothing is sent before the yes, and nothing
 * is charged before the bytes are on disk.
 *
 * `media.image_auto_approve_under_cents` is the one lift: 0 asks every time; a positive value
 * lets an image strictly cheaper than it run unasked. Inside a seat turn, `dryRun` is where the
 * founder sees the prompt and the price, and it stamps the bound row so the step's yes covers
 * the replay of this call and no other (`autonomy-dispatch.ts` does the same for the class floor).
 */
import fs from "node:fs";
import { currentBoundApprovals, requireBoundApproval, type BoundCall } from "../../governance/bound-approvals.js";
import { recordToolSpend } from "../../governance/spend-ledger.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { isTrentError } from "../../errors/TrentError.js";
import { record, stringArg } from "../action.js";
import type { ToolCallRecord, ToolContext } from "../types.js";
import type { FetchLike } from "../web/proxied-fetch.js";
import { BRIEF_VARIANTS, IMAGE_ASPECTS, briefPrompt, generateImage, imageFileName, resolveImageRoute, type BriefVariant, type ImageAspect, type ImageRoute, type ImageRouteConfig } from "./image.js";
import { resolveInputPath, resolveOutputPath } from "./paths.js";
import { MEDIA_ADAPTER_NAME } from "./schemas.js";

export const IMAGE_TOOL = "media_image";
const DEFAULT_ASPECT: ImageAspect = "16:9";
/** A prompt is a paragraph; this bounds the preview a human reads and what a provider is sent. */
const MAX_PROMPT_CHARS = 4000;

const DEFAULT_IMAGE_CONFIG: ImageRouteConfig = { image_provider: "auto", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0 };

export interface ImageToolOptions {
  readonly media?: Partial<ImageRouteConfig>;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  readonly seat?: string;
}

interface ImagePlan {
  readonly prompt: string;
  readonly aspect: ImageAspect;
  readonly route: ImageRoute;
  /** Where the prompt came from, for the summary. */
  readonly source: string;
  readonly output: string | undefined;
}

type Planned = { ok: true; plan: ImagePlan } | { ok: false; record: ToolCallRecord };

export interface ImageTool {
  execute(action: string, args: Record<string, unknown>): Promise<ToolCallRecord>;
  requiresApproval(args: Record<string, unknown>): boolean;
  preview(args: Record<string, unknown>): string | undefined;
  dryRun(action: string, args: Record<string, unknown>): Promise<ToolCallRecord>;
}

function isAspect(value: string): value is ImageAspect {
  return (IMAGE_ASPECTS as readonly string[]).includes(value);
}

function isVariant(value: string): value is BriefVariant {
  return (BRIEF_VARIANTS as readonly string[]).includes(value);
}

export function createImageTool(ctx: ToolContext, options: ImageToolOptions): ImageTool {
  const config: ImageRouteConfig = { ...DEFAULT_IMAGE_CONFIG, ...options.media };
  const fail = (action: string, summary: string): ToolCallRecord => record(MEDIA_ADAPTER_NAME, action, "failed", summary);

  function asks(route: ImageRoute): boolean {
    const under = config.image_auto_approve_under_cents;
    return !(under > 0 && route.priceCents < under);
  }

  function previewOf(plan: ImagePlan): string {
    return `generate one ${plan.aspect} image with ${plan.route.provider} ${plan.route.model} for ${plan.route.priceCents} cents (${plan.source}): ${plan.prompt}`;
  }

  function boundCall(action: string, args: Record<string, unknown>): BoundCall {
    const context = currentToolCallContext();
    return {
      adapter: MEDIA_ADAPTER_NAME,
      action,
      tool: IMAGE_TOOL,
      args,
      ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      ...(options.seat === undefined ? {} : { seat: options.seat }),
    };
  }

  function plan(action: string, args: Record<string, unknown>): Planned {
    const typed = stringArg(args, "prompt")?.trim() ?? "";
    const brief = stringArg(args, "brief")?.trim() ?? "";
    let prompt = typed;
    let source = "typed prompt";
    if (brief !== "") {
      const variant = (stringArg(args, "variant") ?? "A").trim().toUpperCase();
      if (!isVariant(variant)) return { ok: false, record: fail(action, `${IMAGE_TOOL} variant must be A, B or C (the thumbnail-brief sections); received ${variant || "nothing"}`) };
      const resolved = resolveInputPath(ctx.workspace, brief);
      if (!resolved.ok) return { ok: false, record: record(MEDIA_ADAPTER_NAME, action, resolved.status, `${IMAGE_TOOL} refused: ${resolved.reason}`) };
      const text = fs.readFileSync(resolved.path.host, "utf8");
      const found = briefPrompt(text, variant);
      if (found === undefined) {
        return { ok: false, record: fail(action, `${resolved.path.rel} has no "Generation prompt (for later):" line under "## ${variant}:"; the thumbnail-brief skill writes one per variant A, B and C`) };
      }
      prompt = found;
      source = `variant ${variant} of ${resolved.path.rel}`;
    }
    if (prompt === "") return { ok: false, record: fail(action, `${IMAGE_TOOL} needs {"prompt": "<what to render>"} or {"brief": "thumbnails/<slug>.md", "variant": "A"}`) };
    if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, record: fail(action, `${IMAGE_TOOL} prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`) };
    const aspect = (stringArg(args, "aspect") ?? DEFAULT_ASPECT).trim();
    if (!isAspect(aspect)) return { ok: false, record: fail(action, `${IMAGE_TOOL} aspect must be one of ${IMAGE_ASPECTS.join(", ")}`) };
    let route: ImageRoute;
    try {
      route = resolveImageRoute(config, options.env);
    } catch (error) {
      if (isTrentError(error)) return { ok: false, record: fail(action, `${IMAGE_TOOL} is not configured. ${error.message}`) };
      throw error;
    }
    return { ok: true, plan: { prompt, aspect, route, source, output: stringArg(args, "output") } };
  }

  return {
    requiresApproval(args) {
      const planned = plan("", args);
      return planned.ok && asks(planned.plan.route);
    },
    preview(args) {
      const planned = plan("", args);
      return planned.ok ? previewOf(planned.plan) : undefined;
    },
    async dryRun(action, args) {
      const planned = plan(action, args);
      if (!planned.ok) return planned.record;
      const { plan: p } = planned;
      if (!asks(p.route)) {
        return record(MEDIA_ADAPTER_NAME, action, "mocked", `${IMAGE_TOOL} would run without asking: ${p.route.priceCents} cents is under media.image_auto_approve_under_cents (${config.image_auto_approve_under_cents}).`);
      }
      const preview = previewOf(p);
      currentBoundApprovals()?.preview(boundCall(action, args), preview);
      return record(
        MEDIA_ADAPTER_NAME,
        action,
        "needs_approval",
        `${IMAGE_TOOL} would ${preview}. Approve to send the prompt and charge the spend ledger; media.image_auto_approve_under_cents lifts the question below a price.`,
      );
    },
    async execute(action, args) {
      const planned = plan(action, args);
      if (!planned.ok) return planned.record;
      const { plan: p } = planned;
      const preview = previewOf(p);
      if (asks(p.route)) {
        const decision = requireBoundApproval(boundCall(action, args), preview);
        if (!decision.granted) return decision.record;
      }
      let image;
      try {
        image = await generateImage(p.route, { prompt: p.prompt, aspect: p.aspect }, options.env, options.fetchImpl ?? fetch);
      } catch (error) {
        return fail(action, `${IMAGE_TOOL} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}; nothing was written or charged`);
      }
      const out = resolveOutputPath(ctx.workspace, p.output, imageFileName(image.bytes, image.mimeType));
      if (!out.ok) return record(MEDIA_ADAPTER_NAME, action, out.status, `${IMAGE_TOOL} refused: ${out.reason}`);
      fs.writeFileSync(out.path.host, image.bytes);
      const context = currentToolCallContext();
      const row = recordToolSpend({
        run_id: context?.runId ?? "none",
        tool: IMAGE_TOOL,
        provider: p.route.provider,
        model: p.route.model,
        cents: p.route.priceCents,
        units: 1,
        ...(options.seat === undefined ? {} : { seat: options.seat }),
      });
      const charged = row === undefined ? `${p.route.priceCents} cents NOT recorded: no spend ledger is open in this process` : `${p.route.priceCents} cents recorded on the spend ledger`;
      return record(MEDIA_ADAPTER_NAME, action, "completed", `${out.path.rel}: ${image.bytes.length} bytes ${image.mimeType}, ${p.aspect}, from ${p.route.provider} ${p.route.model} (${p.source}); ${charged}`);
    },
  };
}
