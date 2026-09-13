import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Discord's platform. Enable with:
 *   TRENT_TEST_LIVE=1 DISCORD_BOT_TOKEN=... [DISCORD_TEST_CHANNEL_ID=<target>] npx vitest run packages/trent-core/src/gateway/platforms/discord.live
 */
describe.skipIf(!liveEnabled("DISCORD_BOT_TOKEN"))("discord live", () => {
  const adapter = liveAdapter("discord");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("DISCORD_TEST_CHANNEL_ID"))("delivers a real message to DISCORD_TEST_CHANNEL_ID", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("DISCORD_TEST_CHANNEL_ID")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("discord");
    expect(receipt.messageId).not.toBe("");
  });
});
