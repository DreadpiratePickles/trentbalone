/**
 * `media_image` over a fake HTTP server on the loopback: the Gemini `generateContent` shape and
 * the OpenAI-compatible `/images/generations` shape are both served from one `node:http` server
 * whose base URL reaches the tool through the same env vars an operator would set
 * (`GEMINI_BASE_URL`, `OPENAI_BASE_URL`). No provider is called; no key leaves this process.
 *
 * What is proved: the request an image costs money to make is parked as a bound approval with
 * the prompt and the price as its preview, and nothing is sent until a human decides that row;
 * `media.image_auto_approve_under_cents` lifts the question only below the threshold; the image
 * lands under the workspace under a content-hash name; the charge is one ledger row in integer
 * cents with the provider; a missing key is a typed configuration error naming the variable and
 * the key that would move the provider; a `thumbnail-brief` file is accepted as the prompt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXIT, TrentError } from "../../errors/TrentError.js";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../../governance/bound-approvals.js";
import { installSpendLedger, openSpendLedger, type SpendLedger } from "../../governance/spend-ledger.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { IMAGE_PROVIDERS } from "../../config/sections/media.js";
import { PROVIDER_ALIASES } from "../../model-gateway/providers.js";
import { briefPrompt, DEFAULT_GEMINI_IMAGE_MODEL, GEMINI_IMAGE_PRICE_CENTS, imageFileName, resolveImageRoute } from "./image.js";
import { createMediaAdapter, MEDIA_TOOL_NAMES, MEDIA_TOOL_SCHEMAS } from "./index.js";

const KEY = "AIzaFixtureKeyThatMustNeverAppearInAnyRecord0000";
const OPENAI_KEY = "sk-fixture-openai-key-that-must-never-appear";
/** A byte string with the PNG magic, so the sniffer accepts it and the hash is stable. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture image body for media_image", "utf8")]);
const PROMPT = "A clean chart on a dark background with the text 2 SECONDS bottom left, no faces, no logos.";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const BRIEF = `# Thumbnails: Why viewers leave in the first three seconds

Hook: Two seconds. That is what is killing your video.
Emotion to carry: recognition
Palette: ink background, signal accent, paper text
Avoid looking like: red arrows on a graph

## A: face plus text
Composition: creator on the right third, looking at a large retention graph.
Text: "2 SECONDS"
Face: the moment you notice your own mistake.
Colours: ink, signal, paper.
Alt text: A creator looks at a large retention graph.
Shoot list: window light from the left; hold the phone at eye level.
Generation prompt (for later): A clean chart on a dark background showing a viewer retention
curve that drops sharply at the three-second mark, large flat text "2 SECONDS" bottom left,
space on the right third left empty. No faces, no logos.

## B: the object or the result
Composition: the retention graph alone, full frame.
Text: "HERE"
Face: none.
Colours: ink, signal, paper.
Alt text: A close-up of a retention graph with a sharp early drop.
Shoot list: export the graph at full size.
Generation prompt (for later): A close-up of a retention graph with a sharp early drop, the word
"HERE" next to the marked drop, dark background, one bright accent colour.

## C: before and after
Composition: two small graphs stacked.
Text: "ONE CUT"
Face: quiet satisfaction.
Colours: ink, signal, paper.
Alt text: Two retention graphs stacked.
Shoot list: same light as A.
Generation prompt (for later): Two stacked charts, the top dropping early and the bottom holding,
an accent bar between them, text "ONE CUT" left, empty bottom-right corner.

## Test plan
First compare: A against C.
`;

describe("media_image over a fake provider", () => {
  let root = "";
  let workspace = "";
  let profileDir = "";
  let server: http.Server;
  let base = "";
  const seen: Seen[] = [];
  let status = 200;
  let bindings: BoundApprovalStore;
  let ledger: SpendLedger;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-image-"));
    workspace = path.join(root, "repo");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(path.join(workspace, "thumbnails"), { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, "thumbnails", "retention.md"), BRIEF);
    fs.writeFileSync(path.join(root, "outside.md"), BRIEF);
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        if (status !== 200) {
          res.end(JSON.stringify({ error: { message: "quota exceeded for this fixture" } }));
          return;
        }
        if ((req.url ?? "").includes(":generateContent")) {
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "here is your image" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] }));
        } else {
          res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString("base64") }] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen.length = 0;
    status = 200;
    bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    installBoundApprovals(bindings);
    fs.rmSync(path.join(profileDir, "spend.ndjson"), { force: true });
    ledger = openSpendLedger({ profileDir });
    installSpendLedger(ledger);
    fs.rmSync(path.join(workspace, "media-out"), { recursive: true, force: true });
  });

  afterEach(() => {
    installBoundApprovals(undefined);
    installSpendLedger(undefined);
  });

  const geminiEnv = (): NodeJS.ProcessEnv => ({ PATH: "", HOME: root, GEMINI_API_KEY: KEY, GEMINI_BASE_URL: `${base}/v1beta` });
  const openaiEnv = (): NodeJS.ProcessEnv => ({ PATH: "", HOME: root, OPENAI_API_KEY: OPENAI_KEY, OPENAI_BASE_URL: `${base}/v1` });

  function adapter(env: NodeJS.ProcessEnv, image: Partial<{ image_provider: string; image_model: string; image_price_cents: number; image_auto_approve_under_cents: number }> = {}) {
    return createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      {
        env,
        media: {
          backend: "host", hosted_transcription: false, whisper_model: "",
          image_provider: "auto", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0,
          ...image,
        } as never,
      },
    );
  }

  const expectedName = imageFileName(PNG, "image/png");

  it("declares media_image beside the five clip tools, with the brief named as a path", () => {
    expect([...MEDIA_TOOL_NAMES]).toEqual(["media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"]);
    const schema = MEDIA_TOOL_SCHEMAS.find((s) => s.name === "media_image");
    expect(schema).toBeDefined();
    const props = schema!.parameters.properties as Record<string, { description?: string; enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual(["aspect", "brief", "output", "prompt", "variant"]);
    expect(props.brief?.description ?? "").toMatch(/path/i);
    expect(props.aspect?.enum).toContain("16:9");
    expect(schema!.description).toMatch(/approv/i);
    expect(schema!.description).toMatch(/cents/i);
    // The config enum names the alias table literally (a config section imports no runtime module); this holds them together.
    expect([...IMAGE_PROVIDERS]).toEqual(["auto", "google", "openai", ...PROVIDER_ALIASES]);
  });

  it("asks first: the call is parked with the prompt and the price, nothing is sent, and the approved row lets exactly that call run", async () => {
    const a = adapter(geminiEnv());
    const action = `media_image ${JSON.stringify({ prompt: PROMPT, aspect: "16:9" })}`;
    expect(a.requiresApproval(action)).toBe(true);
    const preview = a.preview?.(action) ?? "";
    expect(preview).toContain(PROMPT);
    expect(preview).toMatch(/7 cents/);
    expect(preview).toContain(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(preview).not.toContain(KEY);

    const parked = await a.execute(action, {});
    expect(parked.status, parked.summary).toBe("needs_approval");
    expect(parked.summary).toContain(PROMPT);
    expect(parked.summary).toMatch(/7 cents/);
    expect(parked.summary).not.toContain(KEY);
    expect(seen).toHaveLength(0);
    expect(fs.existsSync(path.join(workspace, "media-out"))).toBe(false);
    expect(ledger.rows()).toHaveLength(0);

    const rows = bindings.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.preview).toBe(preview);
    expect(rows[0]!.details.tool).toBe("media_image");
    bindings.decide(rows[0]!.id, "approved", "bobby");

    const done = await a.execute(action, {});
    expect(done.status, done.summary).toBe("completed");
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`/v1beta/models/${DEFAULT_GEMINI_IMAGE_MODEL}:generateContent`);
    expect(request.headers["x-goog-api-key"]).toBe(KEY);
    expect(request.url).not.toContain(KEY);
    expect(request.body).toEqual({
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "1K" } },
    });

    const file = path.join(workspace, "media-out", expectedName);
    expect(expectedName).toBe(`${crypto.createHash("sha256").update(PNG).digest("hex").slice(0, 16)}.png`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).equals(PNG)).toBe(true);
    expect(done.summary).toContain(`media-out/${expectedName}`);
    expect(done.summary).toMatch(/7 cents/);
    expect(done.summary).not.toContain(KEY);

    const charges = ledger.rows();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ surface: "tool", tool: "media_image", provider: "google", model: DEFAULT_GEMINI_IMAGE_MODEL, cents: 7, units: 1, tokens: 0 });
    expect(Number.isInteger(charges[0]!.cents)).toBe(true);
    expect(ledger.dailyTotalCents(new Date())).toBe(7);

    // A different prompt is a different approval: the yes above does not cover it.
    const other = await a.execute(`media_image ${JSON.stringify({ prompt: `${PROMPT} Add a red arrow.`, aspect: "16:9" })}`, {});
    expect(other.status).toBe("needs_approval");
    expect(seen).toHaveLength(1);
  });

  it("inside a seat turn the dry run stamps the preview so the step's yes covers exactly the previewed call", async () => {
    const a = adapter(geminiEnv());
    const action = `media_image ${JSON.stringify({ prompt: PROMPT })}`;
    const step = { runId: "run_img", stepId: "step_1" };
    const paused = await runWithToolCallContext(step, () => a.dryRun!(action, {}));
    expect(paused.status).toBe("needs_approval");
    expect(paused.summary).toMatch(/7 cents/);
    expect(seen).toHaveLength(0);
    const replay = await runWithToolCallContext(step, () => a.execute(action, {}));
    expect(replay.status, replay.summary).toBe("completed");
    expect(seen).toHaveLength(1);
    expect((seen[0]!.body as { generationConfig: { imageConfig: { aspectRatio: string } } }).generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(ledger.rows()[0]).toMatchObject({ run_id: "run_img", cents: 7 });
    // Outside the step, the same action is a new key and asks again.
    const outside = await a.execute(action, {});
    expect(outside.status).toBe("needs_approval");
    expect(seen).toHaveLength(1);
  });

  it("skips the question only under media.image_auto_approve_under_cents", async () => {
    const under = adapter(geminiEnv(), { image_auto_approve_under_cents: 10 });
    const action = `media_image ${JSON.stringify({ prompt: PROMPT, aspect: "1:1" })}`;
    expect(under.requiresApproval(action)).toBe(false);
    const done = await under.execute(action, {});
    expect(done.status, done.summary).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(bindings.list()).toHaveLength(0);
    expect(ledger.rows()).toHaveLength(1);
    expect(ledger.rows()[0]!.cents).toBe(7);

    const at = adapter(geminiEnv(), { image_auto_approve_under_cents: 7 });
    expect(at.requiresApproval(action)).toBe(true);
    const parked = await at.execute(action, {});
    expect(parked.status).toBe("needs_approval");
    expect(seen).toHaveLength(1);
  });

  it("with no image key it fails with a typed configuration error naming the variable and the config key, and sends nothing", async () => {
    const config = { image_provider: "auto", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0 };
    let thrown: unknown;
    try {
      resolveImageRoute(config, { PATH: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TrentError);
    expect((thrown as TrentError).code).toBe(EXIT.CONFIG);
    expect((thrown as TrentError).message).toMatch(/GEMINI_API_KEY/);
    expect((thrown as TrentError).message).toMatch(/media\.image_provider/);
    expect((thrown as TrentError).message).toMatch(/\.env/);

    const a = adapter({ PATH: "", HOME: root, GEMINI_BASE_URL: `${base}/v1beta` }, { image_auto_approve_under_cents: 100 });
    const action = `media_image ${JSON.stringify({ prompt: PROMPT })}`;
    expect(a.requiresApproval(action)).toBe(false);
    const rec = await a.execute(action, {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/GEMINI_API_KEY/);
    expect(rec.summary).toMatch(/media\.image_provider/);
    expect(seen).toHaveLength(0);
    expect(ledger.rows()).toHaveLength(0);

    // A provider pinned by config with its key missing names that key, not Gemini's.
    expect(() => resolveImageRoute({ ...config, image_provider: "google" }, { PATH: "" })).toThrow(/GEMINI_API_KEY/);
    expect(() => resolveImageRoute({ ...config, image_provider: "openai", image_model: "m", image_price_cents: 4 }, { PATH: "" })).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveImageRoute({ ...config, image_provider: "deepseek", image_model: "m", image_price_cents: 4 }, { PATH: "" })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("takes the thumbnail-brief file as the prompt, one variant at a time, and refuses a brief outside the workspace", async () => {
    expect(briefPrompt(BRIEF, "A")).toMatch(/^A clean chart on a dark background showing a viewer retention curve/);
    expect(briefPrompt(BRIEF, "A")).toMatch(/No faces, no logos\.$/);
    expect(briefPrompt(BRIEF, "B")).toMatch(/^A close-up of a retention graph .* one bright accent colour\.$/);
    expect(briefPrompt(BRIEF, "C")).toMatch(/text "ONE CUT" left, empty bottom-right corner\.$/);
    expect(briefPrompt("# Thumbnails: none\n\n## A: face plus text\nText: hi\n", "A")).toBeUndefined();

    const a = adapter(geminiEnv(), { image_auto_approve_under_cents: 100 });
    const done = await a.execute('media_image {"brief":"thumbnails/retention.md","variant":"B","aspect":"16:9"}', {});
    expect(done.status, done.summary).toBe("completed");
    const body = seen[0]!.body as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(body.contents[0]!.parts[0]!.text).toBe(briefPrompt(BRIEF, "B"));
    expect(done.summary).toMatch(/variant B/);

    const missing = await a.execute('media_image {"brief":"thumbnails/retention.md","variant":"D"}', {});
    expect(missing.status).toBe("failed");
    expect(missing.summary).toMatch(/variant/);
    const outside = await a.execute('media_image {"brief":"../outside.md"}', {});
    expect(outside.status).toBe("blocked");
    expect(outside.summary).toMatch(/outside the workspace/);
    const neither = await a.execute("media_image {}", {});
    expect(neither.status).toBe("failed");
    expect(neither.summary).toMatch(/prompt|brief/);
    expect(seen).toHaveLength(1);
  });

  it("reaches an OpenAI-compatible images endpoint as the second provider, with the model and the price the profile configured", async () => {
    const config = { image_provider: "openai", image_model: "fixture-image-model", image_price_cents: 5, image_auto_approve_under_cents: 0 };
    const route = resolveImageRoute(config, openaiEnv());
    expect(route).toMatchObject({ provider: "openai", kind: "openai-images", model: "fixture-image-model", baseUrl: `${base}/v1`, priceCents: 5, keyEnv: "OPENAI_API_KEY" });
    expect(JSON.stringify(route)).not.toContain(OPENAI_KEY);
    expect(() => resolveImageRoute({ ...config, image_model: "" }, openaiEnv())).toThrow(/media\.image_model/);
    expect(() => resolveImageRoute({ ...config, image_price_cents: 0 }, openaiEnv())).toThrow(/media\.image_price_cents/);

    const deepseek = resolveImageRoute({ ...config, image_provider: "deepseek" }, { PATH: "", DEEPSEEK_API_KEY: "k" });
    expect(deepseek).toMatchObject({ provider: "deepseek", kind: "openai-images", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" });
    const ollama = resolveImageRoute({ ...config, image_provider: "ollama", image_price_cents: 0 }, { PATH: "" });
    expect(ollama).toMatchObject({ provider: "ollama", priceCents: 0, baseUrl: "http://127.0.0.1:11434/v1" });

    const a = adapter(openaiEnv(), { ...config, image_auto_approve_under_cents: 100 });
    const done = await a.execute(`media_image ${JSON.stringify({ prompt: PROMPT, aspect: "9:16" })}`, {});
    expect(done.status, done.summary).toBe("completed");
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/images/generations");
    expect(request.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(request.body).toEqual({ model: "fixture-image-model", prompt: PROMPT, n: 1, size: "1024x1536", response_format: "b64_json" });
    expect(fs.existsSync(path.join(workspace, "media-out", expectedName))).toBe(true);
    expect(ledger.rows()[0]).toMatchObject({ surface: "tool", tool: "media_image", provider: "openai", model: "fixture-image-model", cents: 5, units: 1 });
    expect(done.summary).not.toContain(OPENAI_KEY);
  });

  it("a provider refusal is a failed record naming the status; nothing is written, nothing is charged, the key is not echoed", async () => {
    status = 429;
    const a = adapter(geminiEnv(), { image_auto_approve_under_cents: 100 });
    const rec = await a.execute(`media_image ${JSON.stringify({ prompt: PROMPT })}`, {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/429/);
    expect(rec.summary).not.toContain(KEY);
    expect(fs.existsSync(path.join(workspace, "media-out"))).toBe(false);
    expect(ledger.rows()).toHaveLength(0);
  });

  it("prices the shipped Gemini table in integer cents, rounded up, and lets media.image_price_cents override it", () => {
    for (const cents of Object.values(GEMINI_IMAGE_PRICE_CENTS)) expect(Number.isInteger(cents) && cents > 0).toBe(true);
    expect(GEMINI_IMAGE_PRICE_CENTS[DEFAULT_GEMINI_IMAGE_MODEL]).toBe(7);
    const env = { PATH: "", GEMINI_API_KEY: KEY };
    const base_ = { image_provider: "google", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0 };
    expect(resolveImageRoute(base_, env)).toMatchObject({ provider: "google", kind: "gemini", model: DEFAULT_GEMINI_IMAGE_MODEL, priceCents: 7, keyEnv: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta" });
    expect(resolveImageRoute({ ...base_, image_model: "gemini-2.5-flash-image" }, env).priceCents).toBe(4);
    expect(resolveImageRoute({ ...base_, image_model: "gemini-2.5-flash-image", image_price_cents: 9 }, env).priceCents).toBe(9);
    expect(() => resolveImageRoute({ ...base_, image_model: "gemini-unpriced-image" }, env)).toThrow(/media\.image_price_cents/);
    expect(resolveImageRoute(base_, { PATH: "", GOOGLE_API_KEY: KEY }).keyEnv).toBe("GOOGLE_API_KEY");
  });
});
