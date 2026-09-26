/**
 * [P3] The service daemon runs the auto reviewer's pass on its own tick while
 * `governance.auto_review.enabled` is true: `reviewHeldApprovals`, the function `trent approvals
 * list --review` runs, over the profile's pending held calls. A row inside the written policy is
 * decided by the reviewer on the next tick; one outside it is left for the human. With the policy
 * off the daemon runs no such component. Driven through `runCli` with a fake runtime, fake timers
 * for the intervals and a fake reviewer model (`setAutoReviewGatewayForTests`): nothing leaves the
 * process. (service.test.ts is near 500 lines, so this lives beside it.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore } from "@trent/core/gateway/index.js";
import { autoReviewOf, type ReviewGateway } from "@trent/core/governance/auto-review.js";
import { createBoundApprovalStore, type BoundCall } from "@trent/core/governance/bound-approvals.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { GatewayStreamRequest } from "@trent/core/model-gateway/index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";
import { AUTO_REVIEW_TICK_MS, setAutoReviewGatewayForTests } from "../groups/service-daemon.js";

let scratch: string;
let trentHome: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-service-review-"));
  trentHome = path.join(scratch, ".trent");
  process.env.TRENT_HOME = trentHome;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setAutoReviewGatewayForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const MODEL = "fake-reviewer";

function configure(autoReview: boolean): void {
  const manager = new ConfigManager({ profile: "default" });
  const config = manager.loadConfig();
  manager.saveConfig({
    ...config,
    gateway: { ...config.gateway, enabled: false },
    heartbeat: { ...config.heartbeat, enabled: false },
    governance: { ...config.governance, auto_review: { enabled: autoReview, model: MODEL, max_class: "external_send", max_amount_cents: 0, currency: "usd", recipients: ["+15550100"] } },
  } as typeof config);
}

const sms = (to: string, body = "Your table is booked for 7pm tonight."): BoundCall => {
  const args = { to, from: "+15550000", body };
  return { adapter: "business", action: `sms_send ${JSON.stringify(args)}`, tool: "sms_send", args, seat: "support", classes: ["external_send", "customer_facing"] };
};

function park(to: string, body?: string): string {
  const call = sms(to, body);
  return createBoundApprovalStore({ profileDir: trentHome }).require(call, `SMS to ${to}: ${(call.args as { body: string }).body}`).row!.id;
}

function fakeReviewer(): GatewayStreamRequest[] {
  const requests: GatewayStreamRequest[] = [];
  const gateway: ReviewGateway = {
    async complete(req) {
      requests.push(req);
      return { text: JSON.stringify({ decision: "approve", reason: "a booking confirmation to an allowlisted number" }), provider: "openai", model: MODEL, modelTier: "haiku", inputTokens: 100, outputTokens: 20, costCents: 1, estimated: false, priced_as_default: false, finishReason: "stop" };
    },
  };
  setAutoReviewGatewayForTests(async () => gateway);
  return requests;
}

function fakes(): { overrides: CliOverrides; order: string[]; raise: (event: string) => Promise<void> } {
  const order: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const signals = {
    once(event: string, listener: () => void): unknown {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${String(code)}`);
    },
  };
  const runtime = {
    orchestrator: { approve: vi.fn(async () => true), reject: vi.fn(async () => true) },
    companyId: "trent-local",
    store: {},
    run: () =>
      (async function* (): AsyncGenerator<OrcEvent> {
        yield { kind: "run_done", runId: "run_svc", at: "2026-09-26T09:00:00.000Z", run: { status: "completed", summary: "NO_REPLY" } } as OrcEvent;
      })(),
    cleanup: vi.fn(async () => undefined),
  } as unknown as HeadlessRuntime;
  return {
    order,
    overrides: { signals, now: () => new Date("2026-09-26T09:00:00.000Z"), gatewayRuntime: async () => runtime },
    async raise(event) {
      for (const listener of listeners.get(event) ?? []) listener();
      for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

const rows = () => new FileGatewayStore(path.join(trentHome, "gateway.json")).snapshot().approvals;

describe("[P3] trent service daemon runs the auto reviewer on its tick", () => {
  it("a pending call inside the policy is decided on the next tick, one outside it is left, and the pass stops with the daemon", async () => {
    configure(true);
    const inside = park("+15550100");
    const outside = park("+15559999");
    const requests = fakeReviewer();
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ components: expect.arrayContaining([{ name: "auto-review", state: "started" }]) });
    // Nothing is decided before the first tick.
    expect(rows()[inside]?.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_TICK_MS);
    expect(rows()[inside]).toMatchObject({ status: "approved", decidedBy: `auto-review:${MODEL}` });
    expect(rows()[outside]?.status).toBe("pending");
    expect(autoReviewOf(rows()[outside]!)).toMatchObject({ decision: "escalate", rule: "recipient_not_allowed" });
    expect(requests).toHaveLength(1);

    await f.raise("SIGTERM");
    expect(f.order.at(-1)).toBe(`exit:${String(EXIT.INTERRUPT)}`);
    // A new call (another body is another key) parked after the daemon stopped is never reviewed.
    const late = park("+15550100", "Reminder: your table is at 7pm.");
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_TICK_MS * 2);
    expect(rows()[late]?.status).toBe("pending");
    expect(autoReviewOf(rows()[late]!)).toBeUndefined();
  });

  it("with the policy off there is no auto-review component and no row is touched", async () => {
    configure(false);
    const id = park("+15550100");
    const requests = fakeReviewer();
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    const components = (JSON.parse(result.stdout) as { components: Array<{ name: string }> }).components;
    expect(components.map((c) => c.name)).toEqual(["gateway", "cron", "heartbeat"]);
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_TICK_MS * 2);
    expect(rows()[id]?.status).toBe("pending");
    expect(autoReviewOf(rows()[id]!)).toBeUndefined();
    expect(requests).toHaveLength(0);
    await f.raise("SIGTERM");
  });

  it("--dry-run lists the pass in the plan when the policy is on", async () => {
    configure(true);
    const result = await runCli(["service", "daemon", "--dry-run", "--json"], { overrides: fakes().overrides });
    expect((JSON.parse(result.stdout) as { components: unknown[] }).components).toContainEqual({ name: "auto-review", state: "would-start" });
  });
});
