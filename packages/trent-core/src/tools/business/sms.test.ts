/**
 * Outbound SMS through the business toolset against a local fake of api.twilio.com: the message
 * asks at `autonomy: never`, the preview is the recipient and the exact text, exactly one form
 * POST with HTTP Basic auth leaves when approved, a replay in the step is answered from the
 * store, and the segment price lands on the spend ledger in integer cents. There is no inbound
 * SMS tool: that needs a public webhook the CLI does not have (design section 3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProviderServer } from "./testing/fake-provider-server.js";
import { action, buildHarness, inStep, type Harness } from "./testing/harness.js";

let twilio: FakeProviderServer;
let harness: Harness;

function fakeTwilio(): FakeProviderServer {
  const server = new FakeProviderServer();
  server.on("POST", /^\/2010-04-01\/Accounts\/AC_fake\/Messages\.json$/, (req) => {
    const body = req.form?.get("Body") ?? "";
    return {
      status: 201,
      body: { sid: "SM_1", status: "queued", to: req.form?.get("To"), from: req.form?.get("From"), body, num_segments: String(Math.max(1, Math.ceil(body.length / 153))), price: null, price_unit: "USD" },
    };
  });
  return server;
}

beforeEach(async () => {
  twilio = fakeTwilio();
  await twilio.start();
  harness = buildHarness({ endpoints: { twilio: twilio.url }, connected: { twilio: { accessToken: "fake-auth-token", username: "AC_fake" } } });
});

afterEach(async () => {
  harness.cleanup();
  await twilio.stop();
});

const SMS = action("sms_send", { to: "+15550100", from: "+15550199", body: "Hi Jane, your facial is confirmed for Tuesday 2pm. Reply STOP to opt out." });

describe("sms_send", () => {
  it("asks at autonomy never, previews recipient and text, sends once with basic auth, and charges integer cents", async () => {
    expect((await inStep("run_1", "step_1", () => harness.adapter.execute(SMS, {}))).status).toBe("needs_approval");
    expect(twilio.requests).toHaveLength(0);

    const pause = await inStep("run_1", "step_1", () => harness.adapter.dryRun!(SMS, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("+15550100");
    expect(pause.summary).toContain("your facial is confirmed for Tuesday 2pm");

    const done = await inStep("run_1", "step_1", () => harness.adapter.execute(SMS, {}));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("SM_1");
    const posts = twilio.received("POST", /Messages\.json$/);
    expect(posts).toHaveLength(1);
    expect(Object.fromEntries(posts[0]!.form!.entries())).toEqual({ To: "+15550100", From: "+15550199", Body: "Hi Jane, your facial is confirmed for Tuesday 2pm. Reply STOP to opt out." });
    expect(posts[0]?.headers.authorization).toBe(`Basic ${Buffer.from("AC_fake:fake-auth-token").toString("base64")}`);

    const rows = harness.ledger.dailyBySurfaceCents(new Date());
    expect(rows.tool).toBe(1);
    expect(Number.isInteger(harness.ledger.runTotalCents("run_1"))).toBe(true);
    expect(harness.ledger.runTotalCents("run_1")).toBe(1);

    const again = await inStep("run_1", "step_1", () => harness.adapter.execute(SMS, {}));
    expect(again.summary).toBe(done.summary);
    expect(twilio.received("POST", /Messages\.json$/)).toHaveLength(1);
    expect(harness.ledger.runTotalCents("run_1")).toBe(1);
  });

  it("charges one cent per segment, rounded up, for a long message", async () => {
    const long = action("sms_send", { to: "+15550100", from: "+15550199", body: "a".repeat(400) });
    await inStep("run_1", "step_2", () => harness.adapter.dryRun!(long, {}));
    const done = await inStep("run_1", "step_2", () => harness.adapter.execute(long, {}));
    expect(done.status).toBe("completed");
    expect(harness.ledger.runTotalCents("run_1")).toBe(3);
  });

  it("refuses a recipient that is not E.164 and an empty body: the card says so, and even an approval sends nothing", async () => {
    for (const bad of [action("sms_send", { to: "555-0100", from: "+15550199", body: "hi" }), action("sms_send", { to: "+15550100", from: "+15550199", body: "" })]) {
      const pause = await inStep("run_1", "step_3", () => harness.adapter.dryRun!(bad, {}));
      expect(pause.summary).toMatch(/cannot run/);
      const result = await inStep("run_1", "step_3", () => harness.adapter.execute(bad, {}));
      expect(result.status).toBe("failed");
    }
    expect(twilio.requests).toHaveLength(0);
  });

  it("fails naming trent connect twilio when Twilio is not connected, and sends nothing", async () => {
    const bare = buildHarness({ endpoints: { twilio: twilio.url }, connected: {} });
    try {
      await inStep("run_1", "step_1", () => bare.adapter.dryRun!(SMS, {}));
      const result = await inStep("run_1", "step_1", () => bare.adapter.execute(SMS, {}));
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("trent connect twilio");
      expect(twilio.requests).toHaveLength(0);
      expect(bare.ledger.runTotalCents("run_1")).toBe(0);
    } finally {
      bare.cleanup();
    }
  });
});
