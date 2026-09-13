import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { HomeAssistantAdapter } from "./homeassistant.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long-lived-access-token";

describe("HomeAssistantAdapter against a local REST API server", () => {
  let server: FakeServer;
  let adapter: HomeAssistantAdapter;

  beforeEach(async () => {
    server = new FakeServer();
    server
      .on("GET", "/api/", (_r, res) => json(res, 200, { message: "API running." }))
      .on("GET", "/api/config", (_r, res) => json(res, 200, { version: "2025.8.1", location_name: "Home" }))
      .on("POST", "/api/services/notify/mobile_app_pixel", (_r, res) => json(res, 200, []))
      .on("POST", "/api/webhook/trent_in", (_r, res) => { res.writeHead(200); res.end(); });
    await server.start();
    adapter = new HomeAssistantAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { homeassistant: server.baseUrl },
      settings: { HASS_URL: "http://homeassistant.local:8123", HASS_TOKEN: TOKEN, HASS_WEBHOOK_SECRET: "wh-secret" },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await server.stop();
  });

  it("is only configured with a URL and a token (never unconditionally)", () => {
    expect(adapter.isConfigured()).toBe(true);
    const bare = new HomeAssistantAdapter({ config: new ConfigManager({ baseDir: "/nonexistent/x" }), store: new MemoryGatewayStore() });
    expect(bare.isConfigured()).toBe(false);
  });

  it("calls notify services and HA webhooks with Bearer auth and the documented bodies", async () => {
    await adapter.send({ channelId: "notify:mobile_app_pixel", text: "Deploy done", metadata: { title: "Trent" } });
    const [notify] = server.find("POST", "/api/services/notify/mobile_app_pixel");
    expect(notify.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(notify.json).toEqual({ message: "Deploy done", title: "Trent" });
    await adapter.send({ channelId: "webhook:trent_in", text: "ping" });
    expect(server.find("POST", "/api/webhook/trent_in")[0].json).toEqual({ text: "ping" });
  });

  it("accepts inbound automation webhooks only with the shared secret", async () => {
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    const body = JSON.stringify({ text: "front door opened", sender: "automation.front_door", channel: "notify:mobile_app_pixel" });
    const forged = await adapter.handleWebhook({ method: "POST", url: "/webhooks/homeassistant", headers: {}, body });
    expect(forged.status).toBe(403);
    const ok = await adapter.handleWebhook({ method: "POST", url: "/webhooks/homeassistant", headers: { "x-trent-webhook-secret": "wh-secret" }, body });
    expect(ok.status).toBe(200);
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ platform: "homeassistant", senderId: "automation.front_door", channelId: "notify:mobile_app_pixel", content: "front door opened", scope: "dm" }));
    const h = await adapter.health();
    expect(h.state).toBe("up");
    expect(h.detail).toContain("2025.8.1");
  });
});
