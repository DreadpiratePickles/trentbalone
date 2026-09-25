/**
 * [P2-12] A queued post with media: `social_schedule` resolves the files at queue time, the job
 * carries each path with its size and digest, and at send time the publish handler re-reads every
 * file first: a file that is gone or changed since the approval stops the post before any upload.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTrentTools } from "../index.js";
import type { TrentToolAdapter } from "../types.js";
import { readCronJobs } from "../cron/index.js";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../../governance/bound-approvals.js";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { SOCIAL_ADAPTER_NAME, type SocialAdapterOptions } from "./index.js";
import { createSocialPublishHandler, type SocialQueueEntry } from "./queue.js";
import { startFakePlatforms, type FakePlatforms } from "./testing/fake-platforms.js";
import { mp4, png } from "./testing/media-fixtures.js";

let home: string;
let profileDir: string;
let workspace: string;
let platforms: FakePlatforms;
let clock: Date;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-qmedia-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-qmedia-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(workspace, "media-out"), { recursive: true });
  platforms = await startFakePlatforms();
  clock = new Date("2026-09-20T12:00:00Z");
});

afterEach(async () => {
  installBoundApprovals(undefined);
  await platforms.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function options(): SocialAdapterOptions {
  return {
    fetchImpl: platforms.fetch,
    connected: () => new Set(["bluesky"]),
    platformTokens: async () => undefined,
    providerToken: async (id) => (id === "bluesky" ? { provider: "bluesky", kind: "basic", accessToken: "fake-app-password-q", username: "spa.bsky.social", scopes: [], refreshed: false } : undefined),
    endpoints: { bluesky: "https://bsky.social", buffer: "https://api.buffer.com" },
    now: () => clock,
  };
}

function build(): { social: TrentToolAdapter; bindings: BoundApprovalStore; idempotency: IdempotencyManager } {
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const idempotency = new IdempotencyManager();
  const built = buildTrentTools({ toolsets: ["social"], disabled_toolsets: [], autonomy: "never" }, { workspace, profileDir, backend: "local", home, idempotency, bindings, social: options() });
  const social = built.adapters.find((adapter) => adapter.name === SOCIAL_ADAPTER_NAME);
  if (!social) throw new Error("the social adapter was not built");
  return { social, bindings, idempotency };
}

const inStep = <T>(fn: () => Promise<T>): Promise<T> => runWithToolCallContext({ runId: "run_qm", stepId: "step_1" }, fn);
const SCHEDULE = `social_schedule ${JSON.stringify({
  platform: "bluesky",
  text: "Sunday brunch is back",
  media: [
    { path: "media-out/brunch.png", alt: "Pancakes on the terrace" },
    { path: "media-out/terrace.png", alt: "The terrace at ten" },
  ],
  at: "2026-09-21T15:00:00Z",
})}`;
const uploads = () => platforms.requests.filter((r) => r.path.startsWith("/xrpc/com.atproto.repo.uploadBlob"));
const records = () => platforms.requests.filter((r) => r.path.startsWith("/xrpc/com.atproto.repo.createRecord"));

async function queueIt(): Promise<{ handler: ReturnType<typeof createSocialPublishHandler>; entry: SocialQueueEntry; jobId: string }> {
  const { social, bindings, idempotency } = build();
  const pause = await inStep(() => social.dryRun!(SCHEDULE, {}));
  expect(pause.status).toBe("needs_approval");
  expect(pause.summary).toContain("media-out/brunch.png");
  expect(pause.summary).toContain('alt "Pancakes on the terrace"');
  const queued = await inStep(() => social.execute(SCHEDULE, {}));
  expect(queued.status, queued.summary).toBe("completed");
  const [job] = readCronJobs(profileDir);
  const entry = job!.payload as SocialQueueEntry;
  return { handler: createSocialPublishHandler({ profileDir, social: options(), bindings, idempotency }), entry, jobId: job!.id };
}

describe("social_schedule with media", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(workspace, "media-out", "brunch.png"), png(1200, 900, 3000));
    fs.writeFileSync(path.join(workspace, "media-out", "terrace.png"), png(900, 1200, 4000));
  });

  it("the job carries each file's path, size and digest, and the tick uploads them and posts the embed", async () => {
    const { handler, entry, jobId } = await queueIt();
    expect(entry.request.media?.map((m) => [m.path, m.bytes, m.mime, m.alt])).toEqual([
      ["media-out/brunch.png", 3000, "image/png", "Pancakes on the terrace"],
      ["media-out/terrace.png", 4000, "image/png", "The terrace at ten"],
    ]);
    expect(entry.request.media?.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && path.isAbsolute(m.file))).toBe(true);
    expect(entry.preview).toContain("media-out/terrace.png (4,000 bytes, image/png");
    expect(uploads()).toEqual([]);

    const job = readCronJobs(profileDir).find((j) => j.id === jobId)!;
    const outcome = await handler(job, { now: new Date("2026-09-21T15:00:10Z"), trigger: "manual" });
    expect(outcome.failed, outcome.summary).toBeFalsy();
    expect(uploads()).toHaveLength(2);
    const record = (JSON.parse(records()[0]!.body) as { record: { embed: { $type: string; images: Array<{ alt: string }> } } }).record;
    expect(record.embed.$type).toBe("app.bsky.embed.images");
    expect(record.embed.images.map((i) => i.alt)).toEqual(["Pancakes on the terrace", "The terrace at ten"]);
  });

  it("a file deleted before the send stops the post before any upload, and names the file", async () => {
    const { handler, jobId } = await queueIt();
    fs.rmSync(path.join(workspace, "media-out", "terrace.png"));
    const job = readCronJobs(profileDir).find((j) => j.id === jobId)!;
    const outcome = await handler(job, { now: new Date("2026-09-21T15:00:10Z"), trigger: "manual" });
    expect(outcome.failed).toBe(true);
    expect(outcome.summary).toMatch(/social_media_missing: media-out\/terrace\.png/);
    expect(uploads()).toEqual([]);
    expect(records()).toEqual([]);
  });

  it("a file changed after the approval stops the post: what leaves is what was approved", async () => {
    const { handler, jobId } = await queueIt();
    fs.writeFileSync(path.join(workspace, "media-out", "brunch.png"), png(1200, 900, 3001));
    const job = readCronJobs(profileDir).find((j) => j.id === jobId)!;
    const outcome = await handler(job, { now: new Date("2026-09-21T15:00:10Z"), trigger: "manual" });
    expect(outcome.failed).toBe(true);
    expect(outcome.summary).toMatch(/social_media_changed: media-out\/brunch\.png/);
    expect(uploads()).toEqual([]);
  });

  it("a queued clip goes out as a video embed", async () => {
    fs.writeFileSync(path.join(workspace, "media-out", "clip.mp4"), mp4(1080, 1920, { size: 20_000 }));
    const { social, bindings, idempotency } = build();
    const action = `social_schedule ${JSON.stringify({ platform: "bluesky", text: "Clip", media: [{ path: "media-out/clip.mp4", alt: "A clip" }], at: "2026-09-21T15:00:00Z" })}`;
    await inStep(() => social.dryRun!(action, {}));
    expect((await inStep(() => social.execute(action, {}))).status).toBe("completed");
    const [job] = readCronJobs(profileDir);
    const outcome = await createSocialPublishHandler({ profileDir, social: options(), bindings, idempotency })(job!, { now: new Date("2026-09-21T15:00:10Z"), trigger: "manual" });
    expect(outcome.failed, outcome.summary).toBeFalsy();
    expect(uploads()[0]!.headers["content-type"]).toBe("video/mp4");
    expect((JSON.parse(records()[0]!.body) as { record: { embed: { $type: string } } }).record.embed.$type).toBe("app.bsky.embed.video");
  });
});
