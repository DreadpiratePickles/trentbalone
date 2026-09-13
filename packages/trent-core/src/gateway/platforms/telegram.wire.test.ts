import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { TelegramAdapter } from "./telegram.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage, ButtonCallback } from "../transport/types.js";

const TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

describe("TelegramAdapter against a local Bot API server", () => {
  let server: FakeServer;
  let adapter: TelegramAdapter;
  let updatesServed = 0;

  beforeEach(async () => {
    server = new FakeServer();
    updatesServed = 0;
    server
      .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 42, is_bot: true, first_name: "Trent", username: "trent_bot" } }))
      .on("POST", `/bot${TOKEN}/getUpdates`, (req, res) => {
        const body = req.json as { offset?: number; timeout: number; allowed_updates: string[] };
        updatesServed += 1;
        if (updatesServed === 1) {
          return json(res, 200, { ok: true, result: [
            { update_id: 1000, message: { message_id: 7, from: { id: 555, is_bot: false, first_name: "Ada", username: "ada" }, chat: { id: 555, type: "private" }, date: 1_700_000_000, text: "hello trent" } },
            { update_id: 1001, callback_query: { id: "cbq1", from: { id: 555, is_bot: false, first_name: "Ada" }, message: { message_id: 8, chat: { id: 555, type: "private" } }, chat_instance: "x", data: "trent:approve:appr_1:abcdef12" } },
          ] });
        }
        // Long-poll: return nothing until stopped. The offset must have advanced past both updates.
        expect(body.offset).toBe(1002);
        return json(res, 200, { ok: true, result: [] });
      })
      .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: 99, chat: { id: 555 }, date: 1, text: "x" } }))
      .on("POST", `/bot${TOKEN}/answerCallbackQuery`, (_r, res) => json(res, 200, { ok: true, result: true }))
      .on("POST", `/bot${TOKEN}/sendChatAction`, (_r, res) => json(res, 200, { ok: true, result: true }));
    await server.start();
    adapter = new TelegramAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { telegram: server.baseUrl },
      settings: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "whsec" },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await server.stop();
  });

  it("is configured, pinned, and sends the documented sendMessage body with an inline keyboard", async () => {
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.apiVersion).toMatch(/^Bot API/);
    const receipt = await adapter.send({
      channelId: "555",
      text: "Deploy?",
      buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny" }]],
    });
    expect(receipt).toEqual({ platform: "telegram", messageId: "99" });
    const [req] = server.find("POST", `/bot${TOKEN}/sendMessage`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.json).toEqual({
      chat_id: 555,
      text: "Deploy?",
      reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "trent:approve:appr_1:abcdef12" }, { text: "Deny", callback_data: "trent:deny:appr_1:abcdef12" }]] },
    });
  });

  it("long-polls getUpdates, delivers messages and callbacks, and answers the callback", async () => {
    const inbound: InboundMessage[] = [];
    const callbacks: ButtonCallback[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    adapter.onCallback(async (c) => { callbacks.push(c); return { ok: true, text: "Approved." }; });
    await adapter.start();
    await waitFor(() => inbound.length === 1 && callbacks.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({
      id: "7", platform: "telegram", channelId: "555", senderId: "555", senderName: "ada", content: "hello trent", scope: "dm",
      timestamp: new Date(1_700_000_000 * 1000).toISOString(),
    }));
    expect(callbacks[0]).toEqual(expect.objectContaining({ platform: "telegram", callbackId: "cbq1", senderId: "555", channelId: "555", scope: "dm", actionId: "trent:approve:appr_1:abcdef12" }));
    await waitFor(() => server.find("POST", `/bot${TOKEN}/answerCallbackQuery`).length === 1);
    expect(server.find("POST", `/bot${TOKEN}/answerCallbackQuery`)[0].json).toEqual({ callback_query_id: "cbq1", text: "Approved." });
    const first = server.find("POST", `/bot${TOKEN}/getUpdates`)[0].json as Record<string, unknown>;
    expect(first.allowed_updates).toEqual(["message", "callback_query"]);
    expect(first.timeout).toBeGreaterThan(0);
    const health = await adapter.health();
    expect(health.state).toBe("up");
    expect(health.detail).toContain("trent_bot");
  });

  it("accepts a webhook update only with the secret token header", async () => {
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    const update = JSON.stringify({ update_id: 5, message: { message_id: 1, from: { id: 9, first_name: "B" }, chat: { id: -100, type: "supergroup" }, date: 1, text: "group hi" } });
    const forged = await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers: {}, body: update });
    expect(forged.status).toBe(403);
    const ok = await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers: { "x-telegram-bot-api-secret-token": "whsec" }, body: update });
    expect(ok.status).toBe(200);
    await waitFor(() => inbound.length === 1);
    expect(inbound[0].scope).toBe("group");
    expect(inbound[0].channelId).toBe("-100");
  });

  it("never puts the token in an error message", async () => {
    server.on("POST", `/bot${TOKEN}/sendPhoto`, (_r, res) => json(res, 400, { ok: false, description: `Bad Request: token ${TOKEN}` }));
    await expect(adapter.send({ channelId: "1", text: "x", attachments: [{ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }] })).rejects.toThrow(/\[redacted\]/);
  });
});
