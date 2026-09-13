import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { ConfigManager } from "../../config/ConfigManager.js";
import { SlackAdapter } from "./slack.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import { FakeSocketServer } from "../testing/fakeSocket.js";
import type { InboundMessage, ButtonCallback } from "../transport/types.js";

const BOT = "xoxb-test-bot-token-000";
const APP = "xapp-1-test-app-token-000";
const SIGNING = "8f742231b10e8888abcd99yyyzzz85a5";

describe("SlackAdapter against local Web API + Socket Mode servers", () => {
  let http: FakeServer;
  let socket: FakeSocketServer;
  let adapter: SlackAdapter;

  beforeEach(async () => {
    http = new FakeServer();
    socket = new FakeSocketServer();
    await socket.start();
    http
      .on("POST", "/api/apps.connections.open", (_r, res) => json(res, 200, { ok: true, url: socket.url }))
      .on("POST", "/api/auth.test", (_r, res) => json(res, 200, { ok: true, url: "https://t.slack.com/", team: "T1", user: "trent", team_id: "T1", user_id: "UBOT", bot_id: "B1" }))
      .on("POST", "/api/chat.postMessage", (_r, res) => json(res, 200, { ok: true, channel: "C1", ts: "1700000000.000100" }))
      .on("POST", "/api/reactions.add", (_r, res) => json(res, 200, { ok: true }));
    await http.start();
    adapter = new SlackAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { slack: http.baseUrl },
      settings: { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, SLACK_SIGNING_SECRET: SIGNING },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await socket.stop();
    await http.stop();
  });

  it("posts chat.postMessage with Bearer auth, blocks for buttons and thread_ts", async () => {
    const receipt = await adapter.send({
      channelId: "C1", text: "Deploy?", threadId: "1699999999.000001",
      buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve", style: "primary" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny", style: "danger" }]],
    });
    expect(receipt).toEqual({ platform: "slack", messageId: "1700000000.000100" });
    const [req] = http.find("POST", "/api/chat.postMessage");
    expect(req.headers.authorization).toBe(`Bearer ${BOT}`);
    expect(req.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(req.json).toEqual({
      channel: "C1", text: "Deploy?", thread_ts: "1699999999.000001",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Deploy?" } },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "trent:approve:appr_1:abcdef12", value: "trent:approve:appr_1:abcdef12", style: "primary" },
          { type: "button", text: { type: "plain_text", text: "Deny" }, action_id: "trent:deny:appr_1:abcdef12", value: "trent:deny:appr_1:abcdef12", style: "danger" },
        ] },
      ],
    });
  });

  it("opens Socket Mode, acks envelopes, and delivers messages and block_actions", async () => {
    const inbound: InboundMessage[] = [];
    const callbacks: ButtonCallback[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    adapter.onCallback(async (c) => { callbacks.push(c); return { ok: true, text: "Approved." }; });
    socket.whenConnected((s) => {
      s.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A1" } }));
      s.send(JSON.stringify({ envelope_id: "env-1", type: "events_api", accepts_response_payload: false, payload: { type: "event_callback", event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text: "hi trent", ts: "1700000001.000200" } } }));
      s.send(JSON.stringify({ envelope_id: "env-2", type: "events_api", accepts_response_payload: false, payload: { type: "event_callback", event: { type: "message", subtype: "bot_message", bot_id: "B1", channel: "C1", text: "ignore me", ts: "1" } } }));
      s.send(JSON.stringify({ envelope_id: "env-3", type: "interactive", accepts_response_payload: false, payload: { type: "block_actions", user: { id: "U1" }, channel: { id: "C1" }, trigger_id: "t", actions: [{ action_id: "trent:approve:appr_1:abcdef12", block_id: "b", value: "trent:approve:appr_1:abcdef12", type: "button" }], response_url: `${http.baseUrl}/actions/resp` } }));
    });
    http.on("POST", "/actions/resp", (_r, res) => json(res, 200, { ok: true }));
    await adapter.start();
    const open = http.find("POST", "/api/apps.connections.open")[0];
    expect(open.headers.authorization).toBe(`Bearer ${APP}`);
    await waitFor(() => inbound.length === 1 && callbacks.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "1700000001.000200", platform: "slack", channelId: "D1", senderId: "U1", content: "hi trent", scope: "dm" }));
    expect(callbacks[0]).toEqual(expect.objectContaining({ platform: "slack", callbackId: "env-3", senderId: "U1", channelId: "C1", scope: "group", actionId: "trent:approve:appr_1:abcdef12" }));
    await waitFor(() => socket.received.length >= 3);
    expect(socket.received).toEqual(expect.arrayContaining([{ envelope_id: "env-1" }, { envelope_id: "env-2" }, { envelope_id: "env-3" }]));
    await waitFor(() => http.find("POST", "/actions/resp").length === 1);
    expect(http.find("POST", "/actions/resp")[0].json).toEqual({ text: "Approved.", replace_original: false, response_type: "ephemeral" });
    expect((await adapter.health()).state).toBe("up");
  });

  it("verifies the Events API signature and answers url_verification", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const sig = "v0=" + crypto.createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex");
    const bad = await adapter.handleWebhook({ method: "POST", url: "/webhooks/slack", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=nope" }, body });
    expect(bad.status).toBe(401);
    const stale = await adapter.handleWebhook({ method: "POST", url: "/webhooks/slack", headers: { "x-slack-request-timestamp": String(Number(ts) - 600), "x-slack-signature": sig }, body });
    expect(stale.status).toBe(401);
    const ok = await adapter.handleWebhook({ method: "POST", url: "/webhooks/slack", headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ challenge: "abc123" });
  });
});
