import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Signal's platform. Enable with:
 *   TRENT_TEST_LIVE=1 SIGNAL_NUMBER=... [SIGNAL_TEST_TO=<target>] npx vitest run packages/trent-core/src/gateway/platforms/signal.live
 */
describe.skipIf(!liveEnabled("SIGNAL_NUMBER"))("signal live", () => {
  const adapter = liveAdapter("signal");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("SIGNAL_TEST_TO"))("delivers a real message to SIGNAL_TEST_TO", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("SIGNAL_TEST_TO")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("signal");
    expect(receipt.messageId).not.toBe("");
  });
});
