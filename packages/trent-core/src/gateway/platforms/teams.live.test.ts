import { describe, it, expect, afterAll } from "vitest";
import { liveAdapter, liveEnabled, optionalEnv } from "../testing/live.js";

/**
 * Real round trip against Teams's platform. Enable with:
 *   TRENT_TEST_LIVE=1 TEAMS_CLIENT_SECRET=... [TEAMS_TEST_CHAT_ID=<target>] npx vitest run packages/trent-core/src/gateway/platforms/teams.live
 */
describe.skipIf(!liveEnabled("TEAMS_CLIENT_SECRET"))("teams live", () => {
  const adapter = liveAdapter("teams");
  afterAll(async () => { await adapter.stop(); });

  it("authenticates and reports healthy", async () => {
    expect(adapter.isConfigured()).toBe(true);
    await adapter.start();
    const health = await adapter.health();
    expect(health.state, health.detail).toBe("up");
  });

  it.skipIf(!optionalEnv("TEAMS_TEST_CHAT_ID"))("delivers a real message to TEAMS_TEST_CHAT_ID", async () => {
    const receipt = await adapter.send({ channelId: optionalEnv("TEAMS_TEST_CHAT_ID")!, text: `Trent live test ${new Date().toISOString()}`, metadata: { subject: "Trent live test", title: "Trent" } });
    expect(receipt.platform).toBe("teams");
    expect(receipt.messageId).not.toBe("");
  });
});
