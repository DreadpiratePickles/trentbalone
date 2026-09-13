import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against WhatsApp's platform. Enable with:
 *   TRENT_TEST_LIVE=1 WHATSAPP_TOKEN=... [WHATSAPP_TEST_TO=<target>] npx vitest run packages/trent-core/src/gateway/platforms/whatsapp.live
 */
describe.skipIf(!liveEnabled("WHATSAPP_TOKEN"))("whatsapp live", () => {
  const adapter = liveAdapter("whatsapp");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("WHATSAPP_TEST_TO"))("delivers a real message to WHATSAPP_TEST_TO", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("WHATSAPP_TEST_TO")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("whatsapp");
    expect(receipt.messageId).not.toBe("");
  });
});
