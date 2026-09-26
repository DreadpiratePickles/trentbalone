/**
 * [X4] Editing the post queue on the job file. A queued post's approval is bound to its exact
 * call (`governance/bound-approvals.ts`), so an edit that changes what would leave the machine
 * invalidates that approval and parks a fresh row for the new content; a move that keeps the
 * content keeps the approval; removing the job removes its pending row too. [P2-14] An edit keeps
 * the post's files (re-read where they were approved, refused when changed) unless it names a
 * media URL, and the list names each file with its size.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { boundCallKey, createBoundApprovalStore, type BoundApprovalStore, type BoundCall } from "../../governance/bound-approvals.js";
import { SOCIAL_WRITE_CLASSES, type SocialAdapterOptions } from "../social/index.js";
import { describeMediaFile, renderMediaPreview, resolveMediaFiles, type SocialMediaFile } from "../social/media-files.js";
import { queueSocialPost, type SocialQueueEntry } from "../social/queue.js";
import { png } from "../social/testing/media-fixtures.js";
import { readCronJobs, writeCronJobs } from "./index.js";
import { editQueuedPost, listQueuedPosts, moveQueuedPost, removeQueuedPost } from "./queue-edit.js";

let profileDir: string;
let store: MemoryGatewayStore;
let bindings: BoundApprovalStore;
const clock = new Date("2026-09-20T12:00:00Z");
const now = (): Date => clock;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cron-queue-edit-"));
  store = new MemoryGatewayStore();
  bindings = createBoundApprovalStore({ store });
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const social: SocialAdapterOptions = { connected: () => new Set(["buffer"]), now, providerToken: async () => undefined };
const deps = () => ({ profileDir, store, now, social });

/** A queued post exactly as `social_schedule` writes it after a human approved the previewed call. */
function queued(text = "Sunday brunch is back", at = "2026-09-21T15:00:00Z"): { id: string; call: BoundCall } {
  const args = { platform: "facebook", text, at };
  const action = `social_schedule ${JSON.stringify(args)}`;
  const call: BoundCall = { adapter: "social", action, tool: "social_schedule", args, classes: SOCIAL_WRITE_CLASSES, runId: "run_q", stepId: "step_1" };
  const preview = `post to facebook at ${at}: ${JSON.stringify(text)} (no media)`;
  const parked = bindings.require(call, preview);
  expect(parked.granted).toBe(false);
  bindings.decide(parked.row!.id, "approved", "bobby");
  const entry: SocialQueueEntry = { call, preview, request: { platform: "facebook", text }, at };
  return { id: queueSocialPost(profileDir, entry, clock).id, call };
}

const rowsFor = (call: BoundCall) => Object.values(store.snapshot().approvals).filter((row) => (row.details as { key?: string }).key === boundCallKey(call));

describe("queue list", () => {
  it("lists queued posts only, with their approval state", () => {
    const { id } = queued();
    writeCronJobs(profileDir, [...readCronJobs(profileDir), { id: "job_plain00000", name: "digest", schedule: "@daily", prompt: "digest", enabled: true, created_at: "", updated_at: "" }]);
    const listed = listQueuedPosts(deps());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, platform: "facebook", text: "Sunday brunch is back", at: "2026-09-21T15:00:00.000Z", approval: "approved", enabled: true });
  });
});

describe("queue edit", () => {
  it("a changed text invalidates the bound approval and parks a fresh row for exactly the new content", async () => {
    const { id, call } = queued();
    const result = await editQueuedPost(deps(), id, { text: "Sunday brunch is back, 10am" });
    expect(result.changed).toBe(true);
    expect(result.approval).toMatchObject({ status: "pending" });
    expect(result.approval!.details.preview).toContain("Sunday brunch is back, 10am");
    expect(result.approval!.details.preview).toContain("2026-09-21T15:00:00");

    // The old row no longer grants anything; the new one is pending and bound to the new call.
    expect(rowsFor(call).map((row) => row.status)).toEqual(["expired"]);
    const [job] = readCronJobs(profileDir);
    const entry = job!.payload as SocialQueueEntry;
    expect(entry.request.text).toBe("Sunday brunch is back, 10am");
    expect(entry.call.args).toMatchObject({ text: "Sunday brunch is back, 10am", at: "2026-09-21T15:00:00.000Z" });
    expect(rowsFor(entry.call).map((row) => row.status)).toEqual(["pending"]);
    expect(rowsFor(entry.call)[0]!.id).toBe(result.approval!.id);
    expect(job!.enabled).toBe(true);
    expect(job!.next_run_at).toBe("2026-09-21T15:00:00.000Z");
    expect(bindings.require(entry.call, entry.preview).granted).toBe(false);
  });

  it("an edit back to previously approved content still asks: the row is re-created, never reused", async () => {
    const { id, call } = queued();
    await editQueuedPost(deps(), id, { text: "something else" });
    const back = await editQueuedPost(deps(), id, { text: "Sunday brunch is back" });
    expect(back.changed).toBe(true);
    expect(back.approval).toMatchObject({ status: "pending" });
    // The original approved row was expired by the first edit; the CLI's own call is a new key.
    expect(rowsFor(call).map((row) => row.status)).toEqual(["expired"]);
  });

  it("an edit that changes nothing keeps the approval and writes nothing", async () => {
    const { id, call } = queued();
    const before = fs.readFileSync(path.join(profileDir, "cron", "jobs.json"), "utf8");
    const result = await editQueuedPost(deps(), id, { text: "Sunday brunch is back" });
    expect(result.changed).toBe(false);
    expect(result.approval).toMatchObject({ status: "approved" });
    expect(fs.readFileSync(path.join(profileDir, "cron", "jobs.json"), "utf8")).toBe(before);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
  });

  it("refuses an edit the social toolset would refuse, leaving the job and its approval alone", async () => {
    const { id, call } = queued();
    await expect(editQueuedPost(deps(), id, { mediaUrl: "https://example.test/share?id=1" })).rejects.toThrow(/buffer_media_kind_unknown/);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
    expect((readCronJobs(profileDir)[0]!.payload as SocialQueueEntry).request.mediaUrl).toBeUndefined();
  });

  it("refuses to edit a job that is not a queued post, or one that already published", async () => {
    writeCronJobs(profileDir, [{ id: "job_plain00000", name: "digest", schedule: "@daily", prompt: "digest", enabled: true, created_at: "", updated_at: "" }]);
    await expect(editQueuedPost(deps(), "job_plain00000", { text: "x" })).rejects.toThrow(/not a queued post/);
    await expect(editQueuedPost(deps(), "job_missing000", { text: "x" })).rejects.toThrow(/no queued post/);
    const { id } = queued();
    const jobs = readCronJobs(profileDir).map((job) => (job.id === id ? { ...job, enabled: false, payload: { ...job.payload, published: { externalId: "p1", route: "buffer", at: clock.toISOString() } } } : job));
    writeCronJobs(profileDir, jobs);
    await expect(editQueuedPost(deps(), id, { text: "late" })).rejects.toThrow(/already published/);
  });
});

describe("queue move", () => {
  it("a move that keeps the content keeps the approval and re-anchors the one-shot slot", async () => {
    const { id, call } = queued();
    const result = moveQueuedPost(deps(), id, "2026-09-22T09:30:00Z");
    expect(result).toMatchObject({ id, at: "2026-09-22T09:30:00.000Z", approval: { status: "approved" } });
    const [job] = readCronJobs(profileDir);
    expect(job!.schedule).toBe("30 9 22 9 *");
    expect(job!.next_run_at).toBe("2026-09-22T09:30:00.000Z");
    expect(job!.name).toContain("2026-09-22T09:30:00.000Z");
    const entry = job!.payload as SocialQueueEntry;
    expect(entry.at).toBe("2026-09-22T09:30:00.000Z");
    expect(entry.call).toEqual(call);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
    expect(bindings.require(entry.call, entry.preview).granted).toBe(true);
  });

  it("refuses a time in the past or one that is not a time", () => {
    const { id } = queued();
    expect(() => moveQueuedPost(deps(), id, "2026-09-19T09:30:00Z")).toThrow(/social_schedule_time_past/);
    expect(() => moveQueuedPost(deps(), id, "next tuesday")).toThrow(/social_schedule_time_invalid/);
  });
});

describe("queue rm", () => {
  it("removes the job and its pending row; an approved row is expired so the same call asks again", async () => {
    const { id, call } = queued();
    const pendingJob = queued("A second post");
    const pendingEntry = readCronJobs(profileDir).find((job) => job.id === pendingJob.id)!.payload as SocialQueueEntry;
    // Make the second one's row pending again, as a queued post whose approval was re-asked would be.
    store.mutate((state) => {
      for (const row of Object.values(state.approvals)) if ((row.details as { key?: string }).key === boundCallKey(pendingEntry.call)) row.status = "pending";
      return undefined;
    });

    expect(removeQueuedPost(deps(), pendingJob.id)).toMatchObject({ id: pendingJob.id, approval: "removed" });
    expect(rowsFor(pendingEntry.call)).toEqual([]);
    expect(readCronJobs(profileDir).map((job) => job.id)).toEqual([id]);

    expect(removeQueuedPost(deps(), id)).toMatchObject({ id, approval: "expired" });
    expect(rowsFor(call).map((row) => row.status)).toEqual(["expired"]);
    expect(readCronJobs(profileDir)).toEqual([]);
    expect(() => removeQueuedPost(deps(), id)).toThrow(/no queued post/);
  });
});

describe("queue edit keeps a post's files", () => {
  let workspace: string;
  const FILES = [
    { path: "media-out/brunch.png", alt: "Pancakes on the terrace" },
    { path: "media-out/terrace.png", alt: "The terrace at ten" },
  ];
  const filesDeps = () => ({ profileDir, store, now, social: { connected: () => new Set(["bluesky", "buffer"] as const), now, providerToken: async () => undefined } satisfies SocialAdapterOptions });

  beforeEach(() => {
    // The seat's workspace, apart from the profile: where the files were resolved when approved.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cron-queue-edit-work-"));
    fs.mkdirSync(path.join(workspace, "media-out"));
    fs.writeFileSync(path.join(workspace, "media-out", "brunch.png"), png(1200, 800, 2048));
    fs.writeFileSync(path.join(workspace, "media-out", "terrace.png"), png(800, 800, 1024));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** A Bluesky post with two files, queued exactly as `social_schedule` queues it after the yes. */
  function queuedWithFiles(): { id: string; call: BoundCall; media: SocialMediaFile[] } {
    const media = resolveMediaFiles(workspace, FILES);
    const at = "2026-09-21T15:00:00Z";
    const args = { platform: "bluesky", text: "Sunday brunch is back", media: FILES, at };
    const call: BoundCall = { adapter: "social", action: `social_schedule ${JSON.stringify(args)}`, tool: "social_schedule", args, classes: SOCIAL_WRITE_CLASSES, runId: "run_q", stepId: "step_1" };
    const preview = `post to bluesky at ${at}: "Sunday brunch is back" (${renderMediaPreview(media)})`;
    bindings.decide(bindings.require(call, preview).row!.id, "approved", "bobby");
    const entry: SocialQueueEntry = { call, preview, request: { platform: "bluesky", text: "Sunday brunch is back", media }, at };
    return { id: queueSocialPost(profileDir, entry, clock).id, call, media };
  }

  const entryOf = () => readCronJobs(profileDir)[0]!.payload as SocialQueueEntry;

  it("an edit of the text carries every approved file into the new call, its preview and the job", async () => {
    const { id, call, media } = queuedWithFiles();
    const result = await editQueuedPost(filesDeps(), id, { text: "Sunday brunch is back, 10am" });
    expect(result.changed).toBe(true);
    const preview = result.approval!.details.preview;
    for (const file of media) expect(preview).toContain(describeMediaFile(file));
    const entry = entryOf();
    expect(entry.request).toEqual({ platform: "bluesky", text: "Sunday brunch is back, 10am", media });
    expect(entry.call.args).toMatchObject({ media: FILES });
    expect(entry.preview).toBe(preview);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["expired"]);
    expect(rowsFor(entry.call).map((row) => row.status)).toEqual(["pending"]);
  });

  it("an edit that changes nothing keeps the files and the approval", async () => {
    const { id, call, media } = queuedWithFiles();
    const result = await editQueuedPost(filesDeps(), id, { text: "Sunday brunch is back" });
    expect(result.changed).toBe(false);
    expect(entryOf().request.media).toEqual(media);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
  });

  it("an edit that names a media URL replaces the files: a post carries files or one URL, not both", async () => {
    const { id } = queuedWithFiles();
    await editQueuedPost(filesDeps(), id, { platform: "facebook", mediaUrl: "https://cdn.example.test/brunch.png" });
    const entry = entryOf();
    expect(entry.request.media).toBeUndefined();
    expect(entry.request.mediaUrl).toBe("https://cdn.example.test/brunch.png");
    expect(entry.call.args).not.toHaveProperty("media");
  });

  it("refuses the edit when a file changed since it was approved, leaving the job and its approval alone", async () => {
    const { id, call, media } = queuedWithFiles();
    fs.writeFileSync(path.join(workspace, "media-out", "brunch.png"), png(1200, 800, 4096));
    await expect(editQueuedPost(filesDeps(), id, { text: "Sunday brunch is back, 10am" })).rejects.toThrow(/social_media_changed/);
    expect(entryOf().request).toEqual({ platform: "bluesky", text: "Sunday brunch is back", media });
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
  });

  it("refuses the edit when a file is gone since it was approved", async () => {
    const { id, call } = queuedWithFiles();
    fs.rmSync(path.join(workspace, "media-out", "terrace.png"));
    await expect(editQueuedPost(filesDeps(), id, { text: "Sunday brunch is back, 10am" })).rejects.toThrow(/social_media_missing/);
    expect(rowsFor(call).map((row) => row.status)).toEqual(["approved"]);
  });

  it("the list names each file with its size", () => {
    const { id, media } = queuedWithFiles();
    expect(listQueuedPosts(filesDeps())[0]).toMatchObject({ id, media: media.map((file) => ({ path: file.path, bytes: file.bytes })) });
  });
});
