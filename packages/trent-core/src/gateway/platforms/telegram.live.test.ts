import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Telegram's platform. Enable with:
 *   TRENT_TEST_LIVE=1 TELEGRAM_BOT_TOKEN=... [TELEGRAM_TEST_CHAT_ID=<target>] npx vitest run packages/trent-core/src/gateway/platforms/telegram.live
 */
describe.skipIf(!liveEnabled("TELEGRAM_BOT_TOKEN"))("telegram live", () => {
  const adapter = liveAdapter("telegram");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("TELEGRAM_TEST_CHAT_ID"))("delivers a real message to TELEGRAM_TEST_CHAT_ID", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("TELEGRAM_TEST_CHAT_ID")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("telegram");
    expect(receipt.messageId).not.toBe("");
  });
});
