/**
 * [P3] A held call records whether its run read text written outside this machine. The row writer
 * (`bound-approvals.ts`) stamps `details.untrusted_inbound: true` when the run's policy ring carries
 * an `inbound` entry: the seed a signed webhook plants (`webhooks/taint.ts` seedInboundTaint), an
 * inbox or web read, a solo conversation's session ring, or a run a surface noted as seeded. The auto
 * reviewer (`auto-review.ts`) then leaves such a row for the human whatever the written policy says,
 * and asks no model. Every model here is a fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileGatewayStore } from "../gateway/store/GatewayStore.js";
import { seedInboundTaint } from "../webhooks/taint.js";
import { AutoReviewConfigSchema } from "./auto-review-config.js";
import { autoReviewOf, reviewHeldApprovals, type ReviewGateway } from "./auto-review.js";
import { createBoundApprovalStore, noteInboundRun, UNTRUSTED_INBOUND_FIELD, type BoundCall } from "./bound-approvals.js";
import { PolicyDispatcher } from "./policy-dispatch.js";
import { bindSessionTaint, createSessionTaint, unbindSessionTaint } from "./provenance.js";
import { runWithToolCallContext } from "./tool-call-context.js";

let home: string;
let profileDir: string;
let store: FileGatewayStore;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-untrusted-inbound-"));
  profileDir = path.join(home, ".trent");
  fs.mkdirSync(profileDir, { recursive: true });
  store = new FileGatewayStore(path.join(profileDir, "gateway.json"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ARGS = { to: "+15550100", from: "+15550000", body: "Your table is booked for 7pm tonight." };
const PREVIEW = "SMS from +15550000 to +15550100: Your table is booked for 7pm tonight.";
const inRun = (runId: string): BoundCall => ({ adapter: "business", action: `sms_send ${JSON.stringify(ARGS)}`, tool: "sms_send", args: ARGS, seat: "support", classes: ["external_send", "customer_facing"], runId, stepId: "s1" });
const inside = <T>(runId: string, fn: () => T): Promise<T> => runWithToolCallContext({ runId, stepId: "s1" }, async () => fn());
const stampOf = (details: Record<string, unknown>): unknown => details[UNTRUSTED_INBOUND_FIELD];

describe("[P3] the row writer stamps a held call from a run that read untrusted text", () => {
  it("a run seeded by a webhook: the parked row carries untrusted_inbound, a clean run's does not", async () => {
    const policy = new PolicyDispatcher();
    await seedInboundTaint(policy, "run_seeded", "webhook:gh-issues");
    const bindings = createBoundApprovalStore({ store, ring: () => policy.history() });
    const seeded = await inside("run_seeded", () => bindings.require(inRun("run_seeded"), PREVIEW));
    expect(seeded.granted).toBe(false);
    expect(stampOf(seeded.row!.details)).toBe(true);
    const clean = await inside("run_clean", () => bindings.require(inRun("run_clean"), PREVIEW));
    expect(stampOf(clean.row!.details)).toBeUndefined();
    // The stamp is on the durable row, where `trent approvals` and the reviewer read it.
    expect(stampOf(store.snapshot().approvals[seeded.row!.id]!.details)).toBe(true);
  });

  it("the pause's preview is stamped too, and a parked row is stamped once the run reads inbound text later", async () => {
    const policy = new PolicyDispatcher();
    await seedInboundTaint(policy, "run_paused", "webhook:gh-issues");
    const bindings = createBoundApprovalStore({ store, ring: () => policy.history() });
    const previewed = await inside("run_paused", () => bindings.preview(inRun("run_paused"), PREVIEW));
    expect(stampOf(previewed.details)).toBe(true);

    const first = await inside("run_later", () => bindings.require(inRun("run_later"), PREVIEW));
    expect(stampOf(first.row!.details)).toBeUndefined();
    await inside("run_later", () => policy.remember({ adapter: "inbound", scopes: ["inbound"], tool: "inbox_list", args: {} }));
    const again = await inside("run_later", () => bindings.require(inRun("run_later"), PREVIEW));
    expect(again.granted).toBe(false);
    expect(again.row!.id).toBe(first.row!.id);
    expect(stampOf(again.row!.details)).toBe(true);
  });

  it("with no ring handed in: a solo conversation's session ring, or a run a surface noted as seeded, still stamps", async () => {
    const bindings = createBoundApprovalStore({ store });
    bindSessionTaint("run_solo", createSessionTaint({ calls: [{ tool: "webhook_inbound", classes: ["inbound"], at: 0 }], sources: [] }));
    try {
      const solo = await inside("run_solo", () => bindings.require(inRun("run_solo"), PREVIEW));
      expect(stampOf(solo.row!.details)).toBe(true);
    } finally {
      unbindSessionTaint("run_solo");
    }
    noteInboundRun("run_noted");
    expect(stampOf(bindings.require(inRun("run_noted"), PREVIEW).row!.details)).toBe(true);
    expect(stampOf(bindings.require(inRun("run_unnoted"), PREVIEW).row!.details)).toBeUndefined();
  });
});

describe("[P3] the auto reviewer never decides a stamped row", () => {
  it("a stamped call inside the written policy is escalated to the human with no model asked; the same call unstamped is approved", async () => {
    const policy = new PolicyDispatcher();
    await seedInboundTaint(policy, "run_seeded", "webhook:gh-issues");
    const bindings = createBoundApprovalStore({ store, ring: () => policy.history() });
    const stamped = (await inside("run_seeded", () => bindings.require(inRun("run_seeded"), PREVIEW))).row!.id;
    const clean = (await inside("run_clean", () => bindings.require(inRun("run_clean"), PREVIEW))).row!.id;
    let asked = 0;
    const reviewer: ReviewGateway = {
      async complete() {
        asked += 1;
        return { text: JSON.stringify({ decision: "approve", reason: "allowlisted number, booking text" }), provider: "openai", model: "fake-reviewer", modelTier: "haiku", inputTokens: 1, outputTokens: 1, costCents: 0, estimated: false, priced_as_default: false, finishReason: "stop" };
      },
    };
    const pass = await reviewHeldApprovals({
      store,
      profileDir,
      policy: AutoReviewConfigSchema.parse({ enabled: true, model: "fake-reviewer", max_class: "external_send", recipients: ["+15550100"] }),
      hardline: { home, profileDir },
      gateway: async () => reviewer,
    });
    expect(pass.outcomes.find((o) => o.id === stamped)).toMatchObject({ decision: "escalate", rule: "untrusted_provenance", modelCalled: false, status: "pending" });
    expect(autoReviewOf(store.snapshot().approvals[stamped]!)).toMatchObject({ decision: "escalate", actor: "auto-review:policy", rule: "untrusted_provenance" });
    expect(store.snapshot().approvals[clean]).toMatchObject({ status: "approved", decidedBy: "auto-review:fake-reviewer" });
    expect(asked).toBe(1);
  });
});
