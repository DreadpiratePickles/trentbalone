/**
 * [P2-12] Media on social posts, on the fake platform server. Bluesky: each file under the
 * workspace is uploaded through `com.atproto.repo.uploadBlob` with the MIME its bytes say, then
 * attached as `app.bsky.embed.images` (one to four, alt text required) or `app.bsky.embed.video`
 * (one MP4); the lexicon limits (https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json,
 * .../video.json) refuse a call before anything leaves. Buffer: no upload endpoint
 * (https://developers.buffer.com/guides/hosting-media.md), so a local file is refused with the
 * reason and a hosted `media_url` goes out as an `assets` entry. The approval preview names each
 * file, its size, its digest and its alt text, and a file changed after approval is not sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTrentTools } from "../index.js";
import type { TrentToolAdapter } from "../types.js";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals } from "../../governance/bound-approvals.js";
import { installSpendLedger, openSpendLedger } from "../../governance/spend-ledger.js";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import type { ConnectProviderId } from "../../connect/providers.js";
import { SOCIAL_ADAPTER_NAME, type SocialAdapterOptions } from "./index.js";
import { startFakePlatforms, type FakePlatforms } from "./testing/fake-platforms.js";
import { gif, jpeg, mp4, png, webp } from "./testing/media-fixtures.js";

let home: string;
let profileDir: string;
let workspace: string;
let platforms: FakePlatforms;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-media-home-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-media-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(workspace, "media-out"), { recursive: true });
  platforms = await startFakePlatforms();
  installSpendLedger(openSpendLedger({ profileDir }));
});

afterEach(async () => {
  installBoundApprovals(undefined);
  installSpendLedger(undefined);
  await platforms.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function options(connected: ConnectProviderId[]): SocialAdapterOptions {
  const set = new Set<ConnectProviderId>(connected);
  return {
    fetchImpl: platforms.fetch,
    connected: () => set,
    platformTokens: async () => undefined,
    providerToken: async (id) => {
      if (id === "buffer" && set.has("buffer")) return { provider: "buffer", kind: "api_key", accessToken: "fake-buffer-token-media", scopes: [], refreshed: false };
      if (id === "bluesky" && set.has("bluesky")) return { provider: "bluesky", kind: "basic", accessToken: "fake-app-password-media", username: "spa.bsky.social", scopes: [], refreshed: false };
      return undefined;
    },
    endpoints: { bluesky: "https://bsky.social", buffer: "https://api.buffer.com" },
  };
}

function build(connected: ConnectProviderId[]): TrentToolAdapter {
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const built = buildTrentTools(
    { toolsets: ["social"], disabled_toolsets: [], autonomy: "never" },
    { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager(), bindings, social: options(connected), runId: "run_m" },
  );
  const social = built.adapters.find((adapter) => adapter.name === SOCIAL_ADAPTER_NAME);
  if (!social) throw new Error("the social adapter was not built");
  return social;
}

const inStep = <T>(fn: () => Promise<T>, stepId = "step_1"): Promise<T> => runWithToolCallContext({ runId: "run_m", stepId }, fn);
const put = (rel: string, bytes: Buffer): Buffer => {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), bytes);
  return bytes;
};
const post = (args: Record<string, unknown>) => `social_post ${JSON.stringify(args)}`;
const uploads = () => platforms.requests.filter((r) => r.path.startsWith("/xrpc/com.atproto.repo.uploadBlob"));
const records = () => platforms.requests.filter((r) => r.path.startsWith("/xrpc/com.atproto.repo.createRecord"));
const embedOf = (index = 0) => (JSON.parse(records()[index]!.body) as { record: { embed?: Record<string, unknown>; text: string } }).record;
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** dryRun (the pause that shows the human the preview), then the approved replay. */
async function approveAndRun(social: TrentToolAdapter, action: string, stepId = "step_1") {
  const pause = await inStep(() => social.dryRun!(action, {}), stepId);
  const result = await inStep(() => social.execute(action, {}), stepId);
  return { pause, result };
}

describe("Bluesky images: uploadBlob, then app.bsky.embed.images", () => {
  it("one image: the bytes go up with the MIME from its magic bytes, and the post carries the blob, the alt text and the aspect ratio", async () => {
    const social = build(["bluesky"]);
    const bytes = put("media-out/late-night.png", png(1200, 800, 5000));
    const action = post({ platform: "bluesky", text: "Open late on Thursdays.", media: [{ path: "media-out/late-night.png", alt: "The spa's front desk lit at night" }] });
    const { pause, result } = await approveAndRun(social, action);
    expect(pause.status).toBe("needs_approval");
    expect(result.status, result.summary).toBe("completed");
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]!.headers["content-type"]).toBe("image/png");
    expect(uploads()[0]!.headers.authorization).toBe("Bearer fake-access-jwt-0001");
    expect(uploads()[0]!.raw.equals(bytes)).toBe(true);
    expect(embedOf().text).toBe("Open late on Thursdays.");
    expect(embedOf().embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [{ alt: "The spa's front desk lit at night", image: { $type: "blob", ref: { $link: "bafkreifakeblob1" }, mimeType: "image/png", size: 5000 }, aspectRatio: { width: 1200, height: 800 } }],
    });
  });

  it("two images keep their order, and a JPEG named .png goes up as image/jpeg: the bytes decide, not the name", async () => {
    const social = build(["bluesky"]);
    put("media-out/room.png", jpeg(800, 1000));
    put("media-out/tea.webp", webp(640, 480));
    const action = post({ platform: "bluesky", text: "Two rooms.", media: [{ path: "media-out/room.png", alt: "Quiet room" }, { path: "media-out/tea.webp", alt: "Tea tray" }] });
    const { result } = await approveAndRun(social, action);
    expect(result.status, result.summary).toBe("completed");
    expect(uploads().map((r) => r.headers["content-type"])).toEqual(["image/jpeg", "image/webp"]);
    const images = (embedOf().embed as { images: Array<{ alt: string; image: { ref: { $link: string } }; aspectRatio?: unknown }> }).images;
    expect(images.map((i) => [i.alt, i.image.ref.$link])).toEqual([["Quiet room", "bafkreifakeblob1"], ["Tea tray", "bafkreifakeblob2"]]);
    expect(images.map((i) => i.aspectRatio)).toEqual([{ width: 800, height: 1000 }, { width: 640, height: 480 }]);
  });

  it("four images go out in one post; a phone JPEG turned by EXIF orientation 6 reports its upright ratio", async () => {
    const social = build(["bluesky"]);
    put("a.png", png(10, 20));
    put("b.gif", gif(30, 40));
    put("c.jpg", jpeg(4032, 3024, { orientation: 6 }));
    put("d.webp", webp(50, 60));
    const media = ["a.png", "b.gif", "c.jpg", "d.webp"].map((p, i) => ({ path: p, alt: `picture ${i + 1}` }));
    const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "Four.", media }));
    expect(result.status, result.summary).toBe("completed");
    expect(uploads().map((r) => r.headers["content-type"])).toEqual(["image/png", "image/gif", "image/jpeg", "image/webp"]);
    const images = (embedOf().embed as { images: Array<{ aspectRatio?: unknown }> }).images;
    expect(images.map((i) => i.aspectRatio)).toEqual([{ width: 10, height: 20 }, { width: 30, height: 40 }, { width: 3024, height: 4032 }, { width: 50, height: 60 }]);
    expect(records()).toHaveLength(1);
  });

  it("five images are refused before any request: Bluesky takes at most four", async () => {
    const social = build(["bluesky"]);
    const media = [1, 2, 3, 4, 5].map((n) => ({ path: put(`p${n}.png`, png(10, 10)) && `p${n}.png`, alt: `p${n}` }));
    const action = post({ platform: "bluesky", text: "Five.", media });
    expect(social.preview!(action)).toMatch(/bluesky_media_too_many.*four/);
    const { result } = await approveAndRun(social, action);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("bluesky_media_too_many");
    expect(platforms.requests).toEqual([]);
  });
});

describe("the preview: every file, its size, its digest and its alt text; no alt text, no call", () => {
  it("names each file with its bytes, type, sha256 prefix and alt text", async () => {
    const social = build(["bluesky"]);
    const a = put("media-out/a.png", png(100, 100, 1234));
    const b = put("media-out/b.jpg", jpeg(10, 10, { size: 2_000_000 }));
    const action = post({ platform: "bluesky", text: "Before and after.", media: [{ path: "media-out/a.png", alt: "Before" }, { path: "media-out/b.jpg", alt: "After, same light" }] });
    const preview = social.preview!(action)!;
    expect(preview).toContain('post to bluesky: "Before and after."');
    expect(preview).toContain(`media-out/a.png (1,234 bytes, image/png, sha256 ${sha(a).slice(0, 12)}) alt "Before"`);
    expect(preview).toContain(`media-out/b.jpg (2,000,000 bytes, image/jpeg, sha256 ${sha(b).slice(0, 12)}) alt "After, same light"`);
    expect(preview).toMatch(/2 images/);
  });

  it("refuses a file without alt text in the preview, in the dry run and in execute, and sends nothing", async () => {
    const social = build(["bluesky"]);
    put("media-out/a.png", png(10, 10));
    for (const media of [[{ path: "media-out/a.png" }], [{ path: "media-out/a.png", alt: "   " }]]) {
      const action = post({ platform: "bluesky", text: "No alt.", media });
      expect(social.preview!(action)).toMatch(/would be refused: social_media_alt_required/);
      const { pause, result } = await approveAndRun(social, action);
      // The pause card the human sees names the refusal; the replay is refused, not sent.
      expect(pause.summary).toContain("social_media_alt_required");
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("social_media_alt_required");
    }
    expect(platforms.requests).toEqual([]);
  });

  it("refuses an image over Bluesky's 2,000,000-byte limit, naming the limit and the file's size", async () => {
    const social = build(["bluesky"]);
    put("media-out/big.png", png(4000, 3000, 2_000_001));
    const action = post({ platform: "bluesky", text: "Big.", media: [{ path: "media-out/big.png", alt: "A big picture" }] });
    expect(social.preview!(action)).toMatch(/bluesky_image_too_large: media-out\/big\.png is 2,000,001 bytes; Bluesky takes at most 2,000,000 bytes per image/);
    const { result } = await approveAndRun(social, action);
    expect(result.status).toBe("failed");
    expect(platforms.requests).toEqual([]);
  });

  it("refuses by the bytes: text named .png, a path outside the workspace, a missing file", async () => {
    const social = build(["bluesky"]);
    put("media-out/fake.png", Buffer.from("this is not a picture at all"));
    const outside = path.join(home, "outside.png");
    fs.writeFileSync(outside, png(10, 10));
    const cases: Array<[string, RegExp]> = [
      ["media-out/fake.png", /social_media_type_unsupported: media-out\/fake\.png .*JPEG, PNG, GIF or WebP.*MP4/],
      [outside, /social_media_outside_workspace/],
      ["media-out/missing.png", /social_media_missing/],
    ];
    for (const [p, expected] of cases) {
      const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "x", media: [{ path: p, alt: "x" }] }));
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(expected);
    }
    expect(platforms.requests).toEqual([]);
  });

  it("a post over 300 graphemes uploads no file: the text limit is checked before the first upload", async () => {
    const social = build(["bluesky"]);
    put("media-out/a.png", png(10, 10));
    const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "x".repeat(301), media: [{ path: "media-out/a.png", alt: "A" }] }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("at most 300 graphemes");
    expect(uploads()).toEqual([]);
  });

  it("a file changed after the human approved it is not sent", async () => {
    const social = build(["bluesky"]);
    put("media-out/a.png", png(10, 10, 100));
    const action = post({ platform: "bluesky", text: "Swap.", media: [{ path: "media-out/a.png", alt: "Original" }] });
    const pause = await inStep(() => social.dryRun!(action, {}));
    expect(pause.status).toBe("needs_approval");
    put("media-out/a.png", png(10, 10, 200));
    const result = await inStep(() => social.execute(action, {}));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("social_media_changed");
    expect(uploads()).toEqual([]);
    expect(records()).toEqual([]);
  });
});

describe("Bluesky video: one MP4, uploadBlob, then app.bsky.embed.video", () => {
  it("uploads the clip as video/mp4 and embeds it with its alt text and upright aspect ratio", async () => {
    const social = build(["bluesky"]);
    const bytes = put("media-out/episode-14.clip-372-411.mp4", mp4(1080, 1920, { size: 50_000 }));
    const action = post({ platform: "bluesky", text: "The no-show note, in 39 seconds.", media: [{ path: "media-out/episode-14.clip-372-411.mp4", alt: "Host explains the no-show note, captions burned in" }] });
    expect(social.preview!(action)).toMatch(/1 video: media-out\/episode-14\.clip-372-411\.mp4 \(50,000 bytes, video\/mp4, sha256 [0-9a-f]{12}\) alt "Host explains/);
    const { result } = await approveAndRun(social, action);
    expect(result.status, result.summary).toBe("completed");
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0]!.headers["content-type"]).toBe("video/mp4");
    expect(uploads()[0]!.raw.equals(bytes)).toBe(true);
    expect(embedOf().embed).toEqual({
      $type: "app.bsky.embed.video",
      video: { $type: "blob", ref: { $link: "bafkreifakeblob1" }, mimeType: "video/mp4", size: 50_000 },
      alt: "Host explains the no-show note, captions burned in",
      aspectRatio: { width: 1080, height: 1920 },
    });
  });

  it("a phone clip rotated 90 degrees reports its upright ratio", async () => {
    const social = build(["bluesky"]);
    put("clip.mp4", mp4(1920, 1080, { rotate90: true }));
    const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "Upright.", media: [{ path: "clip.mp4", alt: "A clip" }] }));
    expect(result.status, result.summary).toBe("completed");
    expect((embedOf().embed as { aspectRatio: unknown }).aspectRatio).toEqual({ width: 1080, height: 1920 });
  });

  it("refuses a QuickTime .mov, a video with images, and two videos, before any request", async () => {
    const social = build(["bluesky"]);
    put("phone.mov", mp4(1080, 1920, { brand: "qt  " }));
    put("a.mp4", mp4(1080, 1920));
    put("b.mp4", mp4(1080, 1920));
    put("a.png", png(10, 10));
    const cases: Array<[Array<{ path: string; alt: string }>, RegExp]> = [
      [[{ path: "phone.mov", alt: "x" }], /social_media_type_unsupported: phone\.mov is video\/quicktime.*MP4/],
      [[{ path: "a.mp4", alt: "x" }, { path: "a.png", alt: "y" }], /bluesky_media_mixed/],
      [[{ path: "a.mp4", alt: "x" }, { path: "b.mp4", alt: "y" }], /bluesky_media_mixed/],
    ];
    for (const [media, expected] of cases) {
      const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "v", media }));
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(expected);
    }
    expect(platforms.requests).toEqual([]);
  });
});

describe("Buffer: no upload endpoint, so a hosted URL or a clear refusal", () => {
  it("refuses a local file on the Buffer path and says a public URL is needed, citing Buffer's docs", async () => {
    const social = build(["buffer"]);
    put("media-out/a.png", png(10, 10));
    const { result } = await approveAndRun(social, post({ platform: "x", text: "Look.", media: [{ path: "media-out/a.png", alt: "A" }] }));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/buffer_media_needs_url: .*no upload endpoint.*public.*https URL.*media_url/);
    expect(result.summary).toContain("https://developers.buffer.com/guides/hosting-media.md");
    expect(platforms.requests).toEqual([]);
  });

  it("sends a hosted image URL as an image asset and a hosted clip as a video asset", async () => {
    const social = build(["buffer"]);
    const image = post({ platform: "x", text: "Half price tonight", media_url: "https://cdn.example/offer.jpg" });
    const imagePreview = social.preview!(image)!;
    expect(imagePreview).toContain("https://cdn.example/offer.jpg");
    expect(imagePreview).toMatch(/fetched .* when the post goes out/);
    const first = await approveAndRun(social, image);
    expect(first.result.status, first.result.summary).toBe("completed");
    // The fake Buffer holds an X and a TikTok channel.
    const video = post({ platform: "tiktok", text: "Our week in 30 seconds", media_url: "https://cdn.example/week.mp4" });
    const second = await approveAndRun(social, video, "step_2");
    expect(second.result.status, second.result.summary).toBe("completed");
    const creates = platforms.requests.filter((r) => r.body.includes("createPost("));
    expect(creates).toHaveLength(2);
    const query = (i: number) => (JSON.parse(creates[i]!.body) as { query: string }).query;
    expect(query(0)).toContain('assets: [{ image: { url: "https://cdn.example/offer.jpg" } }]');
    expect(query(1)).toContain('assets: [{ video: { url: "https://cdn.example/week.mp4" } }]');
  });

  it("refuses a hosted URL whose extension names neither an image nor a video", async () => {
    const social = build(["buffer"]);
    const { result } = await approveAndRun(social, post({ platform: "x", text: "?", media_url: "https://cdn.example/share?id=42" }));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/buffer_media_kind_unknown: .*\.jpg.*\.mp4/);
    expect(platforms.requests.filter((r) => r.body.includes("createPost("))).toEqual([]);
  });

  it("Bluesky refuses a media_url instead of dropping it: it uploads files, so pass media", async () => {
    const social = build(["bluesky"]);
    const { result } = await approveAndRun(social, post({ platform: "bluesky", text: "x", media_url: "https://cdn.example/a.jpg" }));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/bluesky_media_url_unsupported: .*media/);
    expect(records()).toEqual([]);
  });
});
