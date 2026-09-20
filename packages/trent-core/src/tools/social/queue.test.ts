/**
 * [B1] The post queue: `social_schedule` previews and binds the approval at queue time, writes a
 * one-shot job on the CLI's own job file, and the cron runner's tick hands that job to the
 * social publish handler, which sends the approved post exactly once through the idempotent
 * path and disables the job. The fake platform server counts what left.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTrentTools } from "../index.js";
import type { TrentToolAdapter } from "../types.js";
import { readCronJobs } from "../cron/index.js";
import { CronRunner } from "../../cron/CronRunner.js";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../../governance/bound-approvals.js";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { SOCIAL_ADAPTER_NAME, type SocialAdapterOptions } from "./index.js";
import { SOCIAL_PUBLISH_HANDLER, createSocialPublishHandler } from "./queue.js";
import { startFakePlatforms, type FakePlatforms } from "./testing/fake-platforms.js";

let home: string;
let profileDir: string;
let workspace: string;
let platforms: FakePlatforms;
let clock: Date;

const META_TOKEN = "fake-meta-token-queue";

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-queue-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-queue-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
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
    connected: () => new Set(["meta"]),
    // The Meta path is the app's adapter, a route only on a usable app store (`static-graph.test.ts`); the URL is never dialled.
    env: { DATABASE_URL: "postgresql://localhost/trent" },
    platformTokens: async (input) => (input.platform === "facebook" ? { accessToken: META_TOKEN, externalAccountId: input.externalAccountId } : undefined),
    providerToken: async () => undefined,
    now: () => clock,
  };
}

function build(): { social: TrentToolAdapter; bindings: BoundApprovalStore; idempotency: IdempotencyManager } {
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const idempotency = new IdempotencyManager();
  const built = buildTrentTools(
    { toolsets: ["social"], disabled_toolsets: [], autonomy: "never" },
    { workspace, profileDir, backend: "local", home, idempotency, bindings, social: options() },
  );
  const social = built.adapters.find((adapter) => adapter.name === SOCIAL_ADAPTER_NAME);
  if (!social) throw new Error("the social adapter was not built");
  return { social, bindings, idempotency };
}

const SCHEDULE = 'social_schedule {"platform":"facebook","text":"Sunday brunch is back","account_id":"page_42","at":"2026-09-21T15:00:00Z"}';
const inStep = <T>(fn: () => Promise<T>): Promise<T> => runWithToolCallContext({ runId: "run_q", stepId: "step_1" }, fn);
const feedPosts = () => platforms.requests.filter((r) => r.path === "/v20.0/page_42/feed" && r.method === "POST");

describe("social_schedule: approved at queue time, bound to the exact content", () => {
  it("asks at autonomy never and writes no job until the previewed call is granted", async () => {
    const { social } = build();
    expect(social.requiresApproval(SCHEDULE)).toBe(true);
    const parked = await inStep(() => social.execute(SCHEDULE, {}));
    expect(parked.status).toBe("needs_approval");
    expect(readCronJobs(profileDir)).toEqual([]);

    const pause = await inStep(() => social.dryRun!(SCHEDULE, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("Sunday brunch is back");
    expect(pause.summary).toContain("2026-09-21T15:00:00");
    const queued = await inStep(() => social.execute(SCHEDULE, {}));
    expect(queued.status).toBe("completed");
    const jobs = readCronJobs(profileDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.handler).toBe(SOCIAL_PUBLISH_HANDLER);
    expect(jobs[0]!.schedule).toBe("0 15 21 9 *");
    expect(jobs[0]!.next_run_at).toBe("2026-09-21T15:00:00.000Z");
    expect(jobs[0]!.enabled).toBe(true);
    expect(queued.summary).toContain(jobs[0]!.id);
    expect(queued.summary).toMatch(/trent cron start/);
    expect(feedPosts()).toEqual([]);
  });

  it("outside a seat turn the queue call is parked, a denial writes nothing, and a human approval writes the job", async () => {
    const { social, bindings } = build();
    const parked = await social.execute(SCHEDULE, {});
    expect(parked.status).toBe("needs_approval");
    const [row] = bindings.list();
    expect(row).toBeDefined();
    expect(row!.details.preview).toContain("Sunday brunch is back");
    bindings.decide(row!.id, "denied", "bobby");
    expect((await social.execute(SCHEDULE, {})).status).toBe("blocked");
    expect(readCronJobs(profileDir)).toEqual([]);

    const other = SCHEDULE.replace("Sunday brunch", "Monday brunch");
    await social.execute(other, {});
    const [pending] = bindings.list();
    bindings.decide(pending!.id, "approved", "bobby");
    expect((await social.execute(other, {})).status).toBe("completed");
    expect(readCronJobs(profileDir)).toHaveLength(1);
  });

  it("refuses a time in the past", async () => {
    const { social } = build();
    const past = SCHEDULE.replace("2026-09-21T15:00:00Z", "2026-09-19T15:00:00Z");
    await inStep(() => social.dryRun!(past, {}));
    const result = await inStep(() => social.execute(past, {}));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("social_schedule_time_past");
    expect(readCronJobs(profileDir)).toEqual([]);
  });
});

describe("the tick: the queued job publishes once", () => {
  it("publishes the approved post at its slot, disables the job, and a rerun answers from the idempotency store", async () => {
    const { social, bindings, idempotency } = build();
    await inStep(() => social.dryRun!(SCHEDULE, {}));
    expect((await inStep(() => social.execute(SCHEDULE, {}))).status).toBe("completed");
    const [job] = readCronJobs(profileDir);

    const handler = createSocialPublishHandler({ profileDir, social: options(), bindings, idempotency });
    const runner = new CronRunner({
      profileDir,
      now: () => clock,
      log: () => undefined,
      run: () => {
        throw new Error("a queued post must never run as a prompt");
      },
      handlers: { [SOCIAL_PUBLISH_HANDLER]: handler },
    });

    expect((await runner.tick()).launched).toEqual([]);
    expect(feedPosts()).toEqual([]);

    clock = new Date("2026-09-21T15:00:10Z");
    expect((await runner.tick()).launched).toEqual([job!.id]);
    expect(feedPosts()).toHaveLength(1);
    expect(feedPosts()[0]!.body).toContain("Sunday+brunch+is+back");
    const after = readCronJobs(profileDir);
    expect(after[0]!.enabled).toBe(false);
    const [history] = runner.history(job!.id);
    expect(history!.status).toBe("completed");
    expect(history!.summary).toContain("fb_post_1");
    expect(history!.summary).not.toContain(META_TOKEN);

    clock = new Date("2026-09-21T15:01:00Z");
    expect((await runner.tick()).launched).toEqual([]);
    const rerun = await runner.runNow(job!.id);
    expect(rerun.status).toBe("completed");
    expect(rerun.summary).toContain("fb_post_1");
    expect(feedPosts()).toHaveLength(1);
  });
});
