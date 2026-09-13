/**
 * `vision_analyze` against a fake gateway: the message the model receives must carry the image as
 * an OpenAI-compatible `image_url` data URI part, the path floor must hold, and a remote image must
 * go out through the injected (egress) transport. The one live call is in `vision.live.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayCompletion, GatewayStreamRequest, ModelProvider } from "../../model-gateway/types.js";
import { buildVisionMessages, createVisionAdapter, VISION_ADAPTER_NAME, VISION_TOOL_SCHEMAS, type VisionGateway } from "./index.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeGateway(provider: ModelProvider, reply = "A small PNG."): VisionGateway & { requests: GatewayStreamRequest[] } {
  const requests: GatewayStreamRequest[] = [];
  return {
    requests,
    resolveRoute: () => ({ providers: [provider], fallbackChain: [provider], modelTier: "sonnet", explicitModel: "", modelForProvider: () => "m" }),
    complete: async (req) => {
      requests.push(req);
      const completion: GatewayCompletion = {
        text: reply,
        provider,
        model: "m",
        modelTier: "sonnet",
        inputTokens: 10,
        outputTokens: 5,
        costCents: 0,
        estimated: true,
        priced_as_default: false,
        finishReason: "stop",
      };
      return completion;
    },
  };
}

describe("vision toolset", () => {
  let workspace: string;
  let profileDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-vision-ws-"));
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-vision-profile-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("uses Hermes's vision_analyze name and schema keys", () => {
    const schema = VISION_TOOL_SCHEMAS.find((s) => s.name === "vision_analyze");
    expect(schema).toBeDefined();
    expect(Object.keys(schema!.parameters.properties)).toEqual(expect.arrayContaining(["image_url", "image_path", "question"]));
    expect(schema!.parameters.required).toEqual(["question"]);
  });

  it("sends a local image as an OpenAI-compatible image_url data URI with the question", async () => {
    const file = path.join(workspace, "shot.png");
    fs.writeFileSync(file, PNG);
    const gateway = fakeGateway("google");
    const adapter = createVisionAdapter({ workspace, profileDir, gateway });
    expect(adapter.name).toBe(VISION_ADAPTER_NAME);
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute(`vision_analyze {"image_path":"${file}","question":"What colour is it?"}`, {});
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("A small PNG.");
    expect(gateway.requests).toHaveLength(1);
    const messages = gateway.requests[0]!.messages;
    const user = messages.find((m) => m.role === "user")!;
    const parts = user.content as unknown as { type: string; text?: string; image_url?: { url: string } }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.find((p) => p.type === "text")?.text).toContain("What colour is it?");
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(gateway.requests[0]!.role).toBe("executor");
  });

  it("uses Anthropic's image block when the route's first provider is anthropic", () => {
    const messages = buildVisionMessages({ image: PNG, mimeType: "image/png", question: "Describe it.", provider: "anthropic" });
    const user = messages.find((m) => m.role === "user")!;
    const parts = user.content as unknown as { type: string; source?: { type: string; media_type: string; data: string } }[];
    const block = parts.find((p) => p.type === "image");
    expect(block?.source).toEqual({ type: "base64", media_type: "image/png", data: PNG.toString("base64") });
  });

  it("refuses a path outside the workspace and the profile", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trent-vision-outside-"));
    const file = path.join(outside, "secret.png");
    fs.writeFileSync(file, PNG);
    const gateway = fakeGateway("google");
    const adapter = createVisionAdapter({ workspace, profileDir, gateway });
    const result = await adapter.execute(`vision_analyze {"image_path":"${file}","question":"?"}`, {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/outside/);
    expect(gateway.requests).toHaveLength(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a path under the profile (where browser screenshots land)", async () => {
    const dir = path.join(profileDir, "browser", "run_1");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "page.png");
    fs.writeFileSync(file, PNG);
    const gateway = fakeGateway("google");
    const adapter = createVisionAdapter({ workspace, profileDir, gateway });
    const result = await adapter.execute(`vision_analyze {"image_url":"${file}","question":"?"}`, {});
    expect(result.status).toBe("completed");
  });

  it("fetches a remote image through the injected transport and refuses private addresses", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const gateway = fakeGateway("google");
    const adapter = createVisionAdapter({
      workspace,
      profileDir,
      gateway,
      fetchImpl,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const ok = await adapter.execute('vision_analyze {"image_url":"https://example.com/a.png","question":"?"}', {});
    expect(ok.status).toBe("completed");
    expect(fetched).toEqual(["https://example.com/a.png"]);
    const parts = gateway.requests[0]!.messages.find((m) => m.role === "user")!.content as unknown as { type: string; image_url?: { url: string } }[];
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);

    const blocked = await adapter.execute('vision_analyze {"image_url":"http://169.254.169.254/x.png","question":"?"}', {});
    expect(blocked.status).toBe("blocked");
    expect(fetched).toHaveLength(1);
  });

  it("refuses a non-image file", async () => {
    const file = path.join(workspace, "notes.txt");
    fs.writeFileSync(file, "just text");
    const gateway = fakeGateway("google");
    const adapter = createVisionAdapter({ workspace, profileDir, gateway });
    const result = await adapter.execute(`vision_analyze {"image_path":"${file}","question":"?"}`, {});
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/image/);
    expect(gateway.requests).toHaveLength(0);
  });

  it("requires a question and an image", async () => {
    const adapter = createVisionAdapter({ workspace, profileDir, gateway: fakeGateway("google") });
    expect((await adapter.execute('vision_analyze {"question":"?"}', {})).status).toBe("failed");
    expect((await adapter.execute('vision_analyze {"image_path":"x.png"}', {})).status).toBe("failed");
  });
});
