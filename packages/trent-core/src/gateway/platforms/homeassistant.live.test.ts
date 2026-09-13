import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Home Assistant. Enable with:
 *   TRENT_TEST_LIVE=1 HASS_TOKEN=... [HASS_TEST_NOTIFY=<target>] npx vitest run packages/trent-core/src/gateway/platforms/homeassistant.live
 */
describe.skipIf(!liveEnabled("HASS_TOKEN"))("homeassistant live", () => {
  const adapter = liveAdapter("homeassistant");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("HASS_TEST_NOTIFY"))("delivers a real message to HASS_TEST_NOTIFY", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("HASS_TEST_NOTIFY")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("homeassistant");
    expect(receipt.messageId).not.toBe("");
  });
});
