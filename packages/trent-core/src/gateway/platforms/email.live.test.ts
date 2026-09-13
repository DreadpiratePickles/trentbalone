import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Email's platform. Enable with:
 *   TRENT_TEST_LIVE=1 EMAIL_SMTP_HOST=... [EMAIL_TEST_TO=<target>] npx vitest run packages/trent-core/src/gateway/platforms/email.live
 */
describe.skipIf(!liveEnabled("EMAIL_SMTP_HOST"))("email live", () => {
  const adapter = liveAdapter("email");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("EMAIL_TEST_TO"))("delivers a real message to EMAIL_TEST_TO", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("EMAIL_TEST_TO")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("email");
    expect(receipt.messageId).not.toBe("");
  });
});
