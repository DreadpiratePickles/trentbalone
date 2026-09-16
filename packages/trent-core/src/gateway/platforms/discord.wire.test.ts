import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { DiscordAdapter, DISCORD_INTENTS } from "./discord.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import { FakeSocketServer } from "../testing/fakeSocket.js";
import type { InboundMessage, ButtonCallback, InboundReaction } from "../transport/types.js";

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.mnopqrstuvwxyz1234567890ABCDEF";

describe("DiscordAdapter against local REST v10 + gateway servers", () => {
  let http: FakeServer;
  let socket: FakeSocketServer;
  let adapter: DiscordAdapter;

  beforeEach(async () => {
    http = new FakeServer();
    socket = new FakeSocketServer();
    await socket.start();
    http
      .on("GET", "/api/v10/gateway/bot", (_r, res) => json(res, 200, { url: socket.url, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } }))
      .on("GET", "/api/v10/users/@me", (_r, res) => json(res, 200, { id: "BOT1", username: "trent", bot: true }))
      .on("POST", "/api/v10/channels/C1/messages", (_r, res) => json(res, 200, { id: "M100", channel_id: "C1", content: "x" }))
      .on("POST", /^\/api\/v10\/interactions\/I1\/tok\/callback$/, (_r, res) => { res.writeHead(204); res.end(); });
    await http.start();
    adapter = new DiscordAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { discord: http.baseUrl },
      settings: { DISCORD_BOT_TOKEN: TOKEN },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await socket.stop();
    await http.stop();
  });

  it("creates a message with Bot auth and button components", async () => {
    const receipt = await adapter.send({
      channelId: "C1", text: "Deploy?",
      buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve", style: "primary" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny", style: "danger" }]],
    });
    expect(receipt).toEqual({ platform: "discord", messageId: "M100" });
    const [req] = http.find("POST", "/api/v10/channels/C1/messages");
    expect(req.headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(req.headers["user-agent"]).toMatch(/^DiscordBot \(https:\/\/\S+, \S+\)$/);
    expect(req.json).toEqual({
      content: "Deploy?",
      components: [{ type: 1, components: [
        { type: 2, style: 1, label: "Approve", custom_id: "trent:approve:appr_1:abcdef12" },
        { type: 2, style: 4, label: "Deny", custom_id: "trent:deny:appr_1:abcdef12" },
      ] }],
    });
  });

  it("identifies on the gateway, heartbeats, and dispatches MESSAGE_CREATE and INTERACTION_CREATE", async () => {
    const inbound: InboundMessage[] = [];
    const callbacks: ButtonCallback[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    adapter.onCallback(async (c) => { callbacks.push(c); return { ok: true, text: "Approved." }; });
    socket.whenConnected((s) => {
      s.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60 } }));
      s.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { op: number; d?: unknown };
        if (frame.op === 2) {
          s.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { v: 10, user: { id: "BOT1", username: "trent" }, session_id: "sess", resume_gateway_url: socket.url } }));
          s.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "M1", channel_id: "D9", author: { id: "U1", username: "ada" }, content: "hi trent", timestamp: "2024-01-01T00:00:00.000Z" } }));
          s.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "M2", channel_id: "C1", guild_id: "G1", author: { id: "BOT1", username: "trent", bot: true }, content: "self", timestamp: "2024-01-01T00:00:00.000Z" } }));
          s.send(JSON.stringify({ op: 0, t: "INTERACTION_CREATE", s: 4, d: { id: "I1", token: "tok", type: 3, channel_id: "C1", guild_id: "G1", member: { user: { id: "U1", username: "ada" } }, data: { custom_id: "trent:approve:appr_1:abcdef12", component_type: 2 } } }));
        }
        if (frame.op === 1) s.send(JSON.stringify({ op: 11 }));
      });
    });
    await adapter.start();
    await waitFor(() => inbound.length === 1 && callbacks.length === 1);
    const identify = socket.received.find((f) => (f as { op: number }).op === 2) as { op: number; d: Record<string, unknown> };
    expect(identify.d.token).toBe(TOKEN);
    expect(identify.d.intents).toBe(DISCORD_INTENTS);
    expect(identify.d.properties).toEqual({ os: process.platform, browser: "trent", device: "trent" });
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "M1", platform: "discord", channelId: "D9", senderId: "U1", senderName: "ada", content: "hi trent", scope: "dm", timestamp: "2024-01-01T00:00:00.000Z" }));
    expect(callbacks[0]).toEqual(expect.objectContaining({ platform: "discord", callbackId: "I1", senderId: "U1", channelId: "C1", scope: "group", actionId: "trent:approve:appr_1:abcdef12" }));
    await waitFor(() => http.find("POST", "/api/v10/interactions/I1/tok/callback").length === 1);
    expect(http.find("POST", "/api/v10/interactions/I1/tok/callback")[0].json).toEqual({ type: 4, data: { content: "Approved.", flags: 64 } });
    await waitFor(() => socket.received.some((f) => (f as { op: number }).op === 1));
    const hb = socket.received.find((f) => (f as { op: number }).op === 1) as { op: number; d: number | null };
    expect(hb.d).toBeGreaterThanOrEqual(1); // last sequence number
    expect((await adapter.health()).state).toBe("up");
  });

  it("identifies with the reaction intents and surfaces MESSAGE_REACTION_ADD as an InboundReaction, skipping its own", async () => {
    const reactions: InboundReaction[] = [];
    adapter.onReaction(async (r) => { reactions.push(r); });
    socket.whenConnected((s) => {
      s.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60 } }));
      s.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { op: number; d?: unknown };
        if (frame.op === 2) {
          s.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { v: 10, user: { id: "BOT1", username: "trent" }, session_id: "sess", resume_gateway_url: socket.url } }));
          s.send(JSON.stringify({ op: 0, t: "MESSAGE_REACTION_ADD", s: 2, d: { user_id: "BOT1", channel_id: "C1", message_id: "M100", guild_id: "G1", emoji: { id: null, name: "\u{1F44D}" } } }));
          s.send(JSON.stringify({ op: 0, t: "MESSAGE_REACTION_ADD", s: 3, d: { user_id: "U1", channel_id: "C1", message_id: "M100", guild_id: "G1", member: { user: { id: "U1", username: "ada" } }, emoji: { id: null, name: "\u{1F44D}" } } }));
          s.send(JSON.stringify({ op: 0, t: "MESSAGE_REACTION_ADD", s: 4, d: { user_id: "U1", channel_id: "D9", message_id: "M101", emoji: { id: "123456789012345678", name: "custom_yes" } } }));
        }
        if (frame.op === 1) s.send(JSON.stringify({ op: 11 }));
      });
    });
    await adapter.start();
    await waitFor(() => reactions.length === 2);
    const identify = socket.received.find((f) => (f as { op: number }).op === 2) as { op: number; d: Record<string, unknown> };
    expect((identify.d.intents as number) & (1 << 10)).toBe(1 << 10); // GUILD_MESSAGE_REACTIONS
    expect((identify.d.intents as number) & (1 << 13)).toBe(1 << 13); // DIRECT_MESSAGE_REACTIONS
    expect(reactions[0]).toEqual({ platform: "discord", channelId: "C1", messageId: "M100", emoji: "\u{1F44D}", senderId: "U1", scope: "group" });
    expect(reactions[1]).toEqual({ platform: "discord", channelId: "D9", messageId: "M101", emoji: "custom_yes:123456789012345678", senderId: "U1", scope: "dm" });
  });
});
