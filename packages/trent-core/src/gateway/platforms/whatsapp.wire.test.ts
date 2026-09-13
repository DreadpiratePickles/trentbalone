import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { ConfigManager } from "../../config/ConfigManager.js";
import { WhatsAppAdapter, WHATSAPP_GRAPH_VERSION } from "./whatsapp.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage, ButtonCallback } from "../transport/types.js";

const TOKEN = "EAAGm0PX4ZCpsBO_wa_cloud_test_token";
const PHONE_ID = "106540352242922";
const APP_SECRET = "app-secret-0123456789";

describe("WhatsAppAdapter against a local Graph API server", () => {
  let server: FakeServer;
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    server = new FakeServer();
    server
      .on("POST", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}/messages`, (_r, res) => json(res, 200, { messaging_product: "whatsapp", contacts: [{ input: "15551234567", wa_id: "15551234567" }], messages: [{ id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA" }] }))
      .on("GET", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}`, (_r, res) => json(res, 200, { verified_name: "Trent", display_phone_number: "+1 555-123-4567", id: PHONE_ID }));
    await server.start();
    adapter = new WhatsAppAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { whatsapp: server.baseUrl },
      settings: { WHATSAPP_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, WHATSAPP_VERIFY_TOKEN: "verify-me", WHATSAPP_APP_SECRET: APP_SECRET },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await server.stop();
  });

  it("sends a text message and an interactive reply-button message with the documented bodies", async () => {
    expect(adapter.apiVersion).toBe(WHATSAPP_GRAPH_VERSION);
    const r1 = await adapter.send({ channelId: "15551234567", text: "hello" });
    expect(r1.messageId).toMatch(/^wamid\./);
    const [text] = server.find("POST", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}/messages`);
    expect(text.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(text.json).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "15551234567", type: "text", text: { preview_url: false, body: "hello" } });

    await adapter.send({ channelId: "15551234567", text: "Deploy?", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny" }]] });
    const [, interactive] = server.find("POST", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}/messages`);
    expect(interactive.json).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "15551234567", type: "interactive",
      interactive: { type: "button", body: { text: "Deploy?" }, action: { buttons: [
        { type: "reply", reply: { id: "trent:approve:appr_1:abcdef12", title: "Approve" } },
        { type: "reply", reply: { id: "trent:deny:appr_1:abcdef12", title: "Deny" } },
      ] } },
    });
  });

  it("answers the webhook verification handshake and rejects a bad verify token", async () => {
    const ok = await adapter.handleWebhook({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444", headers: {}, body: "" });
    expect(ok).toEqual(expect.objectContaining({ status: 200, body: "1158201444" }));
    const bad = await adapter.handleWebhook({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1", headers: {}, body: "" });
    expect(bad.status).toBe(403);
  });

  it("verifies X-Hub-Signature-256 and dispatches text messages and button replies", async () => {
    const inbound: InboundMessage[] = [];
    const callbacks: ButtonCallback[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    adapter.onCallback(async (c) => { callbacks.push(c); return { ok: true, text: "Approved." }; });
    await adapter.start();
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15551234567", phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: "Ada" }, wa_id: "15557654321" }],
      messages: [
        { from: "15557654321", id: "wamid.in1", timestamp: "1700000000", type: "text", text: { body: "hi trent" } },
        { from: "15557654321", id: "wamid.in2", timestamp: "1700000001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "trent:approve:appr_1:abcdef12", title: "Approve" } } },
      ] } }] }] });
    const sig = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
    const forged = await adapter.handleWebhook({ method: "POST", url: "/webhooks/whatsapp", headers: { "x-hub-signature-256": "sha256=00" }, body });
    expect(forged.status).toBe(401);
    const ok = await adapter.handleWebhook({ method: "POST", url: "/webhooks/whatsapp", headers: { "x-hub-signature-256": sig }, body });
    expect(ok.status).toBe(200);
    await waitFor(() => inbound.length === 1 && callbacks.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "wamid.in1", platform: "whatsapp", channelId: "15557654321", senderId: "15557654321", senderName: "Ada", content: "hi trent", scope: "dm", timestamp: "2023-11-14T22:13:20.000Z" }));
    expect(callbacks[0]).toEqual(expect.objectContaining({ platform: "whatsapp", callbackId: "wamid.in2", senderId: "15557654321", actionId: "trent:approve:appr_1:abcdef12", scope: "dm" }));
    // The ack goes back as a normal text message.
    await waitFor(() => server.find("POST", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}/messages`).length === 1);
    expect((server.find("POST", `/${WHATSAPP_GRAPH_VERSION}/${PHONE_ID}/messages`)[0].json as { text: { body: string } }).text.body).toBe("Approved.");
    const h = await adapter.health();
    expect(h.state).toBe("up");
    expect(h.detail).toContain("Trent");
  });
});
