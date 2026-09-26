/**
 * [X4] `trent cron incidents [ack <job>]` and `trent cron queue list|edit|rm|move` over the same
 * job file. The incident alert leaves through the gateway manager's `send` to `gateway.owner`,
 * the path the heartbeat's replies take, and only once per incident; the queue commands keep or
 * re-ask a queued post's bound approval exactly as the binding says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { openIncidents, readCronIncidents } from "@trent/core/cron/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore, GatewayManager, type OutboundMessage } from "@trent/core/gateway/index.js";
import { boundCallKey, createBoundApprovalStore, type BoundCall } from "@trent/core/governance/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { readCronJobs, writeCronJobs } from "@trent/core/tools/cron/index.js";
import { SOCIAL_WRITE_CLASSES } from "@trent/core/tools/social/index.js";
import type { SocialMediaFile } from "@trent/core/tools/social/media-files.js";
import { queueSocialPost, type SocialQueueEntry } from "@trent/core/tools/social/queue.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";

let home: string;
let clock: Date;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-cron-queue-"));
  process.env.TRENT_HOME = home;
  clock = new Date("2026-09-20T09:00:00.000Z");
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_cron", at: clock.toISOString(), ...extra } as OrcEvent;
}

function configure(extra: Record<string, unknown> = {}, owner = true): void {
  const manager = new ConfigManager({ baseDir: home });
  const config = manager.loadConfig();
  manager.saveConfig({ ...config, ...extra, gateway: { ...config.gateway, ...(owner ? { owner: { platform: "telegram", channelId: "555" } } : {}) } });
}

/** A runtime whose every run fails the same way, and a manager whose `send` is recorded. */
function fakes(events: OrcEvent[]): { overrides: CliOverrides; sent: Array<{ platform: string; message: OutboundMessage }> } {
  const sent: Array<{ platform: string; message: OutboundMessage }> = [];
  const runtime = {
    run: () =>
      (async function* () {
        for (const event of events) yield event;
      })(),
    cleanup: async () => undefined,
  } as unknown as HeadlessRuntime;
  return {
    sent,
    overrides: {
      now: () => clock,
      gatewayRuntime: async () => runtime,
      gatewayManager: (configManager, options) => {
        const manager = new GatewayManager(configManager, options);
        vi.spyOn(manager, "send").mockImplementation(async (platform, message) => {
          sent.push({ platform, message });
          return { queued: "q1", sent: true };
        });
        return manager;
      },
    },
  };
}

async function addDue(): Promise<string> {
  const added = await runCli(["cron", "add", "--schedule", "* * * * *", "--prompt", "count the deals", "--json"]);
  expect(added.exitCode).toBe(EXIT.OK);
  const id = (JSON.parse(added.stdout) as { added: { id: string } }).added.id;
  writeCronJobs(home, readCronJobs(home).map((j) => (j.id === id ? { ...j, next_run_at: clock.toISOString() } : j)));
  return id;
}

async function tickOnce(overrides: CliOverrides): Promise<void> {
  clock = new Date(clock.getTime() + 60_000);
  const result = await runCli(["cron", "start", "--once", "--json"], { overrides });
  expect(result.exitCode).toBe(EXIT.OK);
}

describe("trent cron incidents", () => {
  it("three scheduled failures send one [CRON_FAILURE] alert to gateway.owner; the fourth sends none; ack closes it", async () => {
    configure();
    const id = await addDue();
    const f = fakes([ev("run_start"), ev("run_failed", { detail: "the seat could not read the pipeline" })]);
    await tickOnce(f.overrides);
    await tickOnce(f.overrides);
    expect(f.sent).toEqual([]);
    const empty = await runCli(["cron", "incidents", "--json"]);
    expect(empty.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(empty.stdout)).toEqual({ incidents: [], quotaHoldUntil: null });

    await tickOnce(f.overrides);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ platform: "telegram", message: { channelId: "555" } });
    expect(f.sent[0]!.message.text).toContain("[CRON_FAILURE]");
    expect(f.sent[0]!.message.text).toContain(id);
    await tickOnce(f.overrides);
    expect(f.sent).toHaveLength(1);

    const listed = await runCli(["cron", "incidents", "--json"]);
    expect(listed.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(listed.stdout) as { incidents: Array<{ jobId: string; failures: number; alerted: boolean }> };
    expect(data.incidents).toHaveLength(1);
    expect(data.incidents[0]).toMatchObject({ jobId: id, failures: 4, alerted: true });
    const human = await runCli(["cron", "incidents", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(id);
    expect(human.stdout).toContain("4");

    const acked = await runCli(["cron", "incidents", "ack", id, "--json"]);
    expect(acked.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(acked.stdout)).toMatchObject({ acknowledged: { jobId: id, failures: 4 } });
    expect(openIncidents(home)).toEqual([]);
    const again = await runCli(["cron", "incidents", "ack", id, "--json"]);
    expect(again.exitCode).toBe(EXIT.CONFIG);
    expect(again.stdout).toContain("no open incident");
  });

  it("the threshold is cron.failure_alert_after, and with no owner the incident opens unalerted", async () => {
    configure({ cron: { failure_alert_after: 1, quota_hold_minutes: 30 } }, false);
    const id = await addDue();
    const f = fakes([ev("run_start"), ev("run_failed", { detail: "no route" })]);
    await tickOnce(f.overrides);
    expect(f.sent).toEqual([]);
    expect(openIncidents(home)[0]).toMatchObject({ jobId: id, failures: 1, alerted: false });
  });

  it("a 429 holds prompt jobs for cron.quota_hold_minutes and the listing shows the hold", async () => {
    configure({ cron: { failure_alert_after: 3, quota_hold_minutes: 10 } });
    await addDue();
    const f = fakes([ev("run_start"), ev("run_failed", { detail: "google request failed with HTTP 429 Too Many Requests" })]);
    await tickOnce(f.overrides);
    const until = new Date(clock.getTime() + 10 * 60_000).toISOString();
    expect(readCronIncidents(home).quota_hold_until).toBe(until);
    const listed = await runCli(["cron", "incidents", "--json"], { overrides: f.overrides });
    expect(JSON.parse(listed.stdout)).toMatchObject({ quotaHoldUntil: until });
    clock = new Date(clock.getTime() + 60_000);
    const held = await runCli(["cron", "start", "--once", "--json"], { overrides: f.overrides });
    expect(JSON.parse(held.stdout)).toMatchObject({ launched: [], held: [expect.stringMatching(/^job_/)] });
  });

  it("ack --dry-run reads nothing and answers the convention", async () => {
    const result = await runCli(["cron", "incidents", "ack", "job_0000000000", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toEqual({ dryRun: true, command: "cron incidents ack", id: "job_0000000000" });
  });
});

describe("trent cron queue", () => {
  const store = () => new FileGatewayStore(path.join(home, "gateway.json"));
  const rowsFor = (call: BoundCall) => Object.values(store().snapshot().approvals).filter((row) => (row.details as { key?: string }).key === boundCallKey(call));

  function queued(text = "Sunday brunch is back", at = "2026-09-21T15:00:00Z"): { id: string; call: BoundCall } {
    const args = { platform: "facebook", text, at };
    const call: BoundCall = { adapter: "social", action: `social_schedule ${JSON.stringify(args)}`, tool: "social_schedule", args, classes: SOCIAL_WRITE_CLASSES, runId: "run_q", stepId: "step_1" };
    const bindings = createBoundApprovalStore({ store: store() });
    const preview = `post to facebook at ${at}: ${JSON.stringify(text)} (no media)`;
    const parked = bindings.require(call, preview);
    bindings.decide(parked.row!.id, "approved", "bobby");
    const entry: SocialQueueEntry = { call, preview, request: { platform: "facebook", text }, at };
    return { id: queueSocialPost(home, entry, clock).id, call };
  }

  it("list shows queued posts with their approval state, and nothing else", async () => {
    const { id } = queued();
    await runCli(["cron", "add", "--schedule", "@daily", "--prompt", "digest", "--json"]);
    const result = await runCli(["cron", "queue", "list", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { posts: Array<Record<string, unknown>> };
    expect(data.posts).toHaveLength(1);
    expect(data.posts[0]).toMatchObject({ id, platform: "facebook", text: "Sunday brunch is back", approval: "approved" });
    const human = await runCli(["cron", "queue", "list", "--no-color"]);
    expect(human.stdout).toContain("Sunday brunch is back");
  });

  it("list names each file of a queued post with its size, in the text and in --json", async () => {
    const file = (name: string, bytes: number): SocialMediaFile => ({ path: `media-out/${name}`, file: path.join(home, "work", "media-out", name), alt: `alt for ${name}`, kind: "image", mime: "image/png", bytes, sha256: "a".repeat(64) });
    const media = [file("brunch.png", 123_456), file("terrace.png", 2_048)];
    const at = "2026-09-21T15:00:00Z";
    const args = { platform: "bluesky", text: "Sunday brunch is back", media: media.map((m) => ({ path: m.path, alt: m.alt })), at };
    const call: BoundCall = { adapter: "social", action: `social_schedule ${JSON.stringify(args)}`, tool: "social_schedule", args, classes: SOCIAL_WRITE_CLASSES, runId: "run_q", stepId: "step_1" };
    queueSocialPost(home, { call, preview: "post to bluesky with 2 images", request: { platform: "bluesky", text: "Sunday brunch is back", media }, at }, clock);
    const json = await runCli(["cron", "queue", "list", "--json"]);
    expect(json.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(json.stdout) as { posts: Array<Record<string, unknown>> }).posts[0]).toMatchObject({ media: [{ path: "media-out/brunch.png", bytes: 123_456 }, { path: "media-out/terrace.png", bytes: 2_048 }] });
    const human = await runCli(["cron", "queue", "list", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("media-out/brunch.png (123,456 bytes)");
    expect(human.stdout).toContain("media-out/terrace.png (2,048 bytes)");
  });

  it("edit with a changed text re-asks: a fresh pending row, the old one expired; move keeps it; rm cleans up", async () => {
    // The route check behind the social toolset's dry run needs a connected provider: Buffer here.
    const manager = new ConfigManager({ baseDir: home });
    manager.saveSecrets({ BUFFER_ACCESS_TOKEN: "not-a-real-token" } as Record<string, string>);
    const { id, call } = queued();

    const edited = await runCli(["cron", "queue", "edit", id, "--text", "Sunday brunch is back, 10am", "--json"], { overrides: { now: () => clock } });
    expect(edited.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(edited.stdout) as { id: string; changed: boolean; approval: { id: string; status: string } | null };
    expect(data).toMatchObject({ id, changed: true, approval: { status: "pending" } });
    expect(rowsFor(call).map((row) => row.status)).toEqual(["expired"]);
    const entry = readCronJobs(home)[0]!.payload as SocialQueueEntry;
    expect(entry.request.text).toBe("Sunday brunch is back, 10am");
    expect(rowsFor(entry.call).map((row) => row.status)).toEqual(["pending"]);

    const approvals = await runCli(["approvals", "list", "--json"]);
    expect(approvals.stdout).toContain(data.approval!.id);

    const moved = await runCli(["cron", "queue", "move", id, "2026-09-22T09:30:00Z", "--json"], { overrides: { now: () => clock } });
    expect(moved.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(moved.stdout)).toMatchObject({ id, at: "2026-09-22T09:30:00.000Z", approval: { id: data.approval!.id, status: "pending" } });
    expect(readCronJobs(home)[0]!.next_run_at).toBe("2026-09-22T09:30:00.000Z");
    expect(rowsFor(entry.call).map((row) => row.status)).toEqual(["pending"]);

    const removed = await runCli(["cron", "queue", "rm", id, "--json"]);
    expect(removed.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(removed.stdout)).toEqual({ id, approval: "removed", count: 0 });
    expect(rowsFor(entry.call)).toEqual([]);
    expect(readCronJobs(home)).toEqual([]);
  });

  it("edit refuses a plain scheduled job and an unknown id at exit 3", async () => {
    const added = await runCli(["cron", "add", "--schedule", "@daily", "--prompt", "digest", "--json"]);
    const id = (JSON.parse(added.stdout) as { added: { id: string } }).added.id;
    const plain = await runCli(["cron", "queue", "edit", id, "--text", "x", "--json"]);
    expect(plain.exitCode).toBe(EXIT.CONFIG);
    expect(plain.stdout).toContain("not a queued post");
    const ghost = await runCli(["cron", "queue", "rm", "job_0000000000", "--json"]);
    expect(ghost.exitCode).toBe(EXIT.CONFIG);
    const nothing = await runCli(["cron", "queue", "edit", id, "--json"]);
    expect(nothing.exitCode).toBe(EXIT.CONFIG);
    expect(nothing.stdout).toContain("--text");
  });

  it("--dry-run on the id subcommands answers the convention and touches nothing", async () => {
    for (const [args, command] of [
      [["edit", "job_0000000000", "--text", "x"], "cron queue edit"],
      [["rm", "job_0000000000"], "cron queue rm"],
      [["move", "job_0000000000", "2026-09-22T09:30:00Z"], "cron queue move"],
    ] as const) {
      const result = await runCli(["cron", "queue", ...args, "--dry-run", "--json"]);
      expect(result.exitCode).toBe(EXIT.OK);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command, id: "job_0000000000" });
    }
    expect(fs.existsSync(path.join(home, "cron", "jobs.json"))).toBe(false);
  });
});
