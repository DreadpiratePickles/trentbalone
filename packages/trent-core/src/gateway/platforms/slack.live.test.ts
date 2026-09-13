import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Slack's platform. Enable with:
 *   TRENT_TEST_LIVE=1 SLACK_BOT_TOKEN=... [SLACK_TEST_CHANNEL_ID=<target>] npx vitest run packages/trent-core/src/gateway/platforms/slack.live
 */
describe.skipIf(!liveEnabled("SLACK_BOT_TOKEN"))("slack live", () => {
  const adapter = liveAdapter("slack");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("SLACK_TEST_CHANNEL_ID"))("delivers a real message to SLACK_TEST_CHANNEL_ID", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("SLACK_TEST_CHANNEL_ID")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("slack");
    expect(receipt.messageId).not.toBe("");
  });
});
