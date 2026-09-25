import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { TelegramAdapter } from "./telegram.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage, ButtonCallback, InboundReaction } from "../transport/types.js";
import { saveVoiceNote } from "../voice-notes.js";

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
    expect(first.allowed_updates).toEqual(["message", "callback_query", "message_reaction"]);
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

  it("surfaces a message_reaction update as one InboundReaction per new emoji, and skips anonymous actors", async () => {
    const reactions: InboundReaction[] = [];
    adapter.onReaction(async (r) => { reactions.push(r); });
    const update = (id: number, body: Record<string, unknown>) => JSON.stringify({ update_id: id, message_reaction: { chat: { id: 555, type: "private" }, message_id: 99, date: 1_700_000_100, ...body } });
    const headers = { "x-telegram-bot-api-secret-token": "whsec" };
    const ok = await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers, body: update(6, { user: { id: 555, first_name: "Ada" }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }, { type: "custom_emoji", custom_emoji_id: "5368324170671202286" }] }) });
    expect(ok.status).toBe(200);
    const anonymous = await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers, body: update(7, { actor_chat: { id: -100, type: "supergroup" }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "\u{1F44E}" }] }) });
    expect(anonymous.status).toBe(200);
    const removed = await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers, body: update(8, { user: { id: 555, first_name: "Ada" }, old_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }], new_reaction: [] }) });
    expect(removed.status).toBe(200);
    await waitFor(() => reactions.length === 1);
    expect(reactions).toEqual([{ platform: "telegram", channelId: "555", messageId: "99", emoji: "\u{1F44D}", senderId: "555", scope: "dm" }]);
  });

  it("carries a voice note and an audio file as lazy audio attachments, fetched via getFile only when opened", async () => {
    const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 1]);
    server
      .on("POST", `/bot${TOKEN}/getFile`, (req, res) => {
        const id = (req.json as { file_id: string }).file_id;
        json(res, 200, { ok: true, result: { file_id: id, file_unique_id: "AgADGQ", file_size: OGG.length, file_path: id === "VOICE31" ? "voice/file_3.oga" : "music/missing.mp3" } });
      })
      .on("GET", `/file/bot${TOKEN}/voice/file_3.oga`, (_r, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.from(OGG)); });
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    const headers = { "x-telegram-bot-api-secret-token": "whsec" };
    const from = { id: 555, first_name: "Ada" };
    const chat = { id: 555, type: "private" };
    const voice = { update_id: 20, message: { message_id: 31, from, chat, date: 1_700_000_000, voice: { file_id: "VOICE31", file_unique_id: "AgADGQ", duration: 4, mime_type: "audio/ogg", file_size: OGG.length } } };
    const music = { update_id: 21, message: { message_id: 32, from, chat, date: 1_700_000_001, caption: "the demo", audio: { file_id: "AUDIO32", file_unique_id: "AgADGR", duration: 95, mime_type: "audio/mpeg", file_size: 2048, file_name: "demo.mp3" } } };
    for (const update of [voice, music]) {
      expect((await adapter.handleWebhook({ method: "POST", url: "/webhooks/telegram", headers, body: JSON.stringify(update) })).status).toBe(200);
    }
    await waitFor(() => inbound.length === 2);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "31", senderId: "555", content: "", attachments: [expect.objectContaining({ kind: "audio", mime: "audio/ogg", durationSeconds: 4, sizeBytes: OGG.length })] }));
    expect(inbound[1]).toEqual(expect.objectContaining({ id: "32", content: "the demo", attachments: [expect.objectContaining({ kind: "audio", mime: "audio/mpeg", durationSeconds: 95, sizeBytes: 2048 })] }));
    expect(server.find("POST", `/bot${TOKEN}/getFile`)).toEqual([]); // nothing is fetched before the gateway asks

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tg-voice-"));
    try {
      const file = await saveVoiceNote(inbound[0].attachments![0], { profileDir, platform: "telegram", messageId: inbound[0].id, maxBytes: 1024 });
      expect(file).toBe(path.join(profileDir, "inbox", "telegram", "31.ogg"));
      expect(new Uint8Array(fs.readFileSync(file))).toEqual(OGG);
      expect(server.find("POST", `/bot${TOKEN}/getFile`).map((r) => r.json)).toEqual([{ file_id: "VOICE31" }]);
      // A failed download names the status, never the token that sits in the file URL.
      const failed = await saveVoiceNote(inbound[1].attachments![0], { profileDir, platform: "telegram", messageId: inbound[1].id, maxBytes: 4096 }).catch((err: unknown) => err);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toMatch(/404/);
      expect((failed as Error).message).not.toContain(TOKEN);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("never puts the token in an error message", async () => {
    server.on("POST", `/bot${TOKEN}/sendPhoto`, (_r, res) => json(res, 400, { ok: false, description: `Bad Request: token ${TOKEN}` }));
    await expect(adapter.send({ channelId: "1", text: "x", attachments: [{ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) }] })).rejects.toThrow(/\[redacted\]/);
  });
});
