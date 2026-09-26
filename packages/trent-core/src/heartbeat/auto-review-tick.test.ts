/**
 * [P3] The heartbeat's one hook: a surface hands the loop the auto reviewer's pass
 * (`governance/auto-review.ts` reviewHeldApprovals, the function `trent approvals list --review`
 * runs) and the loop runs it at the start of every tick, quiet or not. A pending held call inside
 * the written policy is decided by the (fake) reviewer on the next tick; one outside the policy is
 * left for the human with the rule named and no model asked. A pass that throws is logged and the
 * tick still runs. Every model here is a fake: no call leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HeartbeatConfig } from "../config/schema.js";
import { FileGatewayStore } from "../gateway/store/GatewayStore.js";
import type { GatewayStreamRequest } from "../model-gateway/types.js";
import { AutoReviewConfigSchema } from "../governance/auto-review-config.js";
import { autoReviewOf, reviewHeldApprovals, type ReviewGateway } from "../governance/auto-review.js";
import { createBoundApprovalStore, type BoundCall } from "../governance/bound-approvals.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { HeartbeatLoop, readHeartbeatRuns } from "./HeartbeatLoop.js";

let home: string;
let profileDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-heartbeat-review-"));
  profileDir = path.join(home, ".trent");
  fs.mkdirSync(profileDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const MODEL = "fake-reviewer";
const POLICY = AutoReviewConfigSchema.parse({ enabled: true, model: MODEL, max_class: "external_send", recipients: ["+15550100"] });
const sms = (to: string): BoundCall => {
  const args = { to, from: "+15550000", body: "Your table is booked for 7pm tonight." };
  return { adapter: "business", action: `sms_send ${JSON.stringify(args)}`, tool: "sms_send", args, seat: "support", classes: ["external_send", "customer_facing"] };
};

const CONFIG: HeartbeatConfig = {
  enabled: true,
  interval_minutes: 30,
  // 03:00 UTC is outside these hours: the tick is quiet, and the pass still runs.
  active_hours: { start: "08:00", end: "20:00", tz: "UTC" },
  consolidate_memory: false,
  sweep: { enabled: false },
  sweep_interval_hours: 24,
};

function loopAt(iso: string, logs: string[] = []): { loop: HeartbeatLoop; runs: string[] } {
  const runs: string[] = [];
  const loop = new HeartbeatLoop({
    profileDir,
    config: CONFIG,
    now: () => new Date(iso),
    log: (line) => logs.push(line),
    deliver: async () => undefined,
    run: (objective) => {
      runs.push(objective);
      return (async function* (): AsyncGenerator<OrcEvent> {
        yield { kind: "run_done", runId: "run_hb", at: iso, run: { status: "completed", summary: "NO_REPLY" } } as OrcEvent;
      })();
    },
  });
  return { loop, runs };
}

function fakeReviewer(): { requests: GatewayStreamRequest[]; factory: () => Promise<ReviewGateway> } {
  const requests: GatewayStreamRequest[] = [];
  const gateway: ReviewGateway = {
    async complete(req) {
      requests.push(req);
      return { text: JSON.stringify({ decision: "approve", reason: "a booking confirmation to an allowlisted number" }), provider: "openai", model: MODEL, modelTier: "haiku", inputTokens: 100, outputTokens: 20, costCents: 1, estimated: false, priced_as_default: false, finishReason: "stop" };
    },
  };
  return { requests, factory: async () => gateway };
}

describe("[P3] the heartbeat runs the auto reviewer's pass on every tick", () => {
  it("a pending call inside the policy is decided by the reviewer on the next tick; one outside it is left, with the rule named", async () => {
    const store = new FileGatewayStore(path.join(profileDir, "gateway.json"));
    const bindings = createBoundApprovalStore({ store });
    const inside = bindings.require(sms("+15550100"), "SMS to +15550100: Your table is booked for 7pm tonight.").row!.id;
    const outside = bindings.require(sms("+15559999"), "SMS to +15559999: Your table is booked for 7pm tonight.").row!.id;
    const reviewer = fakeReviewer();
    const { loop } = loopAt("2026-09-26T03:00:00.000Z");
    loop.beforeEachTick(() => reviewHeldApprovals({ store, profileDir, policy: POLICY, hardline: { home, profileDir }, gateway: reviewer.factory }));

    const row = await loop.tick();
    expect(row.decision).toBe("quiet");
    const after = store.snapshot().approvals;
    expect(after[inside]).toMatchObject({ status: "approved", decidedBy: `auto-review:${MODEL}` });
    expect(after[outside]?.status).toBe("pending");
    expect(autoReviewOf(after[outside]!)).toMatchObject({ decision: "escalate", actor: "auto-review:policy", rule: "recipient_not_allowed" });
    // Only the row inside the policy reached the model.
    expect(reviewer.requests).toHaveLength(1);
  });

  it("a pass that throws is logged, and the tick still runs and leaves its row", async () => {
    const logs: string[] = [];
    const { loop, runs } = loopAt("2026-09-26T09:00:00.000Z", logs);
    loop.beforeEachTick(async () => {
      throw new Error("the review store is unreadable");
    });
    const row = await loop.tick();
    expect(row.decision).toBe("no_reply");
    expect(runs).toHaveLength(1);
    expect(readHeartbeatRuns(profileDir)).toHaveLength(1);
    expect(logs.join("\n")).toContain("the review store is unreadable");
  });

  it("without a hook the tick is exactly what it was", async () => {
    const { loop, runs } = loopAt("2026-09-26T09:00:00.000Z");
    expect((await loop.tick()).decision).toBe("no_reply");
    expect(runs).toHaveLength(1);
  });
});
