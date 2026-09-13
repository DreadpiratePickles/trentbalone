/**
 * The `vision` toolset: Hermes's `vision_analyze` (`~/.hermes/hermes-agent/tools/vision_tools.py:821`)
 * on the configured model through the real model gateway. The image goes in the user message as
 * an OpenAI-compatible `image_url` data URI part (Gemini, OpenAI, OpenRouter and Mistral accept it
 * on the `/chat/completions` path `streamOpenAiCompatibleChat` uses) or, when the route's first
 * provider is Anthropic, as a Messages API `image` block. The gateway's `GatewayMessage.content`
 * is typed `string`; `streamOpenAiCompatibleChat` passes the array through untouched, which is
 * the one place this widening is relied on.
 */
import type { GatewayMessage, ModelGateway, ModelProvider } from "../../model-gateway/types.js";
import { parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import type { EgressClientOptions, FetchLike } from "../web/proxied-fetch.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import type { LookupFn } from "../web/url-safety.js";
import { loadImage, type ImageMime } from "./image-source.js";

export { loadImage, sniffImage, MAX_IMAGE_BYTES } from "./image-source.js";

export const VISION_ADAPTER_NAME = "vision";
/** Hermes `vision_tools.py`: a vision answer is a paragraph, not an essay. */
const VISION_MAX_TOKENS = 1024;

/** The slice of the model gateway vision needs. */
export type VisionGateway = Pick<ModelGateway, "complete" | "resolveRoute">;

export interface VisionAdapterOptions {
  readonly workspace: string;
  readonly profileDir: string;
  /** Bound by the builder. Absent in a bare seat: every call reports `not_available`, never a stub. */
  readonly gateway?: VisionGateway;
  /** Route remote `image_url`s through the egress proxy. */
  readonly egress?: Omit<EgressClientOptions, "lookup">;
  /** Direct transport for tests only. */
  readonly fetchImpl?: FetchLike;
  readonly lookup?: LookupFn;
}

export const VISION_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "vision_analyze",
    description:
      "Look at an image and answer a question about it with the vision model: a browser screenshot, a file in " +
      "the workspace, or a public image URL. Local files must be under the workspace or the Trent profile; " +
      "private and cloud-metadata addresses are refused.",
    parameters: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "Image URL (http/https), local file path, or data: URL to load." },
        image_path: { type: "string", description: "Local image path (PNG, JPEG, GIF or WebP) under the workspace or profile; alternative to image_url." },
        question: { type: "string", description: "Your question or request about the image." },
      },
      required: ["question"],
    },
  },
];

const SPECS: readonly ToolSpec[] = [{ name: "vision_analyze", primary: "question", signature: ["question"] }];

const ROUTING_TEXT =
  "vision look at an image, describe a screenshot, read text in a picture, analyse a photo or diagram, what does this image show";

const SYSTEM_PROMPT =
  "You are a precise visual analyst. Answer the question about the attached image from what is visible. " +
  "Quote any text you read exactly. If the image does not show enough to answer, say so.";

export interface VisionMessageInput {
  readonly image: Buffer;
  readonly mimeType: ImageMime | string;
  readonly question: string;
  readonly provider?: ModelProvider;
}

/** The two multimodal shapes, cast onto the gateway's string-typed content (see the header). */
export function buildVisionMessages(input: VisionMessageInput): GatewayMessage[] {
  const data = input.image.toString("base64");
  const parts: unknown[] =
    input.provider === "anthropic"
      ? [
          { type: "image", source: { type: "base64", media_type: input.mimeType, data } },
          { type: "text", text: input.question },
        ]
      : [
          { type: "text", text: input.question },
          { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${data}` } },
        ];
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts as unknown as string },
  ];
}

/** One vision question through the gateway; the shape `browser_vision` binds to. */
export async function askVision(gateway: VisionGateway, input: Omit<VisionMessageInput, "provider">): Promise<string> {
  const provider = gateway.resolveRoute("executor").providers[0];
  const completion = await gateway.complete({
    messages: buildVisionMessages({ ...input, provider }),
    role: "executor",
    maxTokens: VISION_MAX_TOKENS,
    temperature: 0.1,
  });
  return completion.text.trim();
}

export function createVisionAdapter(options: VisionAdapterOptions): TrentToolAdapter {
  const fail = (action: string, summary: string): ToolCallRecord => record(VISION_ADAPTER_NAME, action, "failed", summary);

  async function analyze(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const question = stringArg(args, "question")?.trim();
    const source = stringArg(args, "image_path")?.trim() || stringArg(args, "image_url")?.trim();
    if (!question) return fail(action, 'vision_analyze requires a non-empty "question".');
    if (!source) return fail(action, 'vision_analyze requires "image_path" (local file) or "image_url" (http(s) URL).');
    const loaded = await loadImage(source, options);
    if (!loaded.ok) return record(VISION_ADAPTER_NAME, action, loaded.status, `vision_analyze refused: ${loaded.reason}`);
    if (!options.gateway) return fail(action, "vision_analyze not_available: no model gateway is bound to this seat, so the image was not analysed.");
    const answer = await askVision(options.gateway, { image: loaded.image.bytes, mimeType: loaded.image.mimeType, question });
    return record(VISION_ADAPTER_NAME, action, "completed", fitSummary(answer || "(the model returned no text)", options.profileDir, "vision"));
  }

  return {
    name: VISION_ADAPTER_NAME,
    scopes: [VISION_ADAPTER_NAME, "vision_analyze"],
    availability: options.gateway ? "real" : "unavailable",
    instructions: renderToolInstructions(VISION_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => (options.gateway?.resolveRoute("executor").providers.length ? "connected" : "needs_credentials"),
    estimateCost: () => 0,
    requiresApproval: () => false,
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return fail(action, error);
      try {
        return await analyze(action, args);
      } catch (err) {
        return fail(action, `vision_analyze failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    },
    async dryRun(action) {
      return record(VISION_ADAPTER_NAME, action, "mocked", `vision dry-run: would analyse the image for "${action}" (read-only).`);
    },
    async cleanup() {
      // Nothing is held open.
    },
  };
}
