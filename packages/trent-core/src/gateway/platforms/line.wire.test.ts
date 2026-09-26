/**
 * [H4] LineAdapter against a local server speaking the LINE Messaging API
 * (https://developers.line.biz/en/reference/messaging-api/): reply and push messages, quick-reply
 * postback buttons, bot info, message content from the data host, and a webhook whose
 * X-Line-Signature is checked before anything is parsed. The webhook rides the existing
 * `/webhooks/<platform>` route of the gateway's WebhookServer, proven over real HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { GatewayManager } from "../GatewayManager.js";
import { WebhookServer } from "../WebhookServer.js";
import { LineAdapter } from "./line.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { ButtonCallback, InboundMessage, WebhookRequest } from "../transport/types.js";

const TOKEN = "fake-line-channel-access-token-0123456789abcdef";
const SECRET = "fake-line-channel-secret-0123456789";
const BOT = "U0000000000000000000000000000b0t0";
const ADA = "U4af4980629aaaaaaaaaaaaaaaaaaaaaa";
const GROUP = "Ca56f94637cc4347f90a25382909b24b";

const sign = (body: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("base64");
let eventSeq = 0;
const event = (extra: Record<string, unknown>) => ({
  mode: "active", timestamp: 1_700_000_000_000, webhookEventId: `01HX${String(++eventSeq).padStart(22, "0")}`,
  deliveryContext: { isRedelivery: false }, source: { type: "user", userId: ADA }, ...extra,
});
const textEvent = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  event({ type: "message", replyToken: `rt-${id}`, message: { id, type: "text", quoteToken: "q", text }, ...extra });
const callback = (events: unknown[]) => JSON.stringify({ destination: BOT, events });
const signed = (body: string): WebhookRequest => ({ method: "POST", url: "/webhooks/line", headers: { "x-line-signature": sign(body), "content-type": "application/json" }, body });

function lineApi(server: FakeServer): void {
  let id = 500_000_000_000_000;
  const sent = (req: { json: unknown }) => ({ sentMessages: ((req.json as { messages: unknown[] }).messages).map(() => ({ id: String(++id), quoteToken: "qt" })) });
  server
    .on("GET", "/v2/bot/info", (_r, res) => json(res, 200, { userId: BOT, basicId: "@123abcde", displayName: "Trent", chatMode: "bot", markAsReadMode: "auto" }))
    .on("POST", "/v2/bot/message/push", (req, res) => json(res, 200, sent(req)))
    .on("POST", "/v2/bot/message/reply", (req, res) => json(res, 200, sent(req)));
}

describe("LineAdapter against a local Messaging API server", () => {
  let server: FakeServer;
  let store: MemoryGatewayStore;
  const adapters: LineAdapter[] = [];

  const make = () => {
    const a = new LineAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store,
      baseUrls: { line: server.baseUrl, "line-data": server.baseUrl },
      settings: { LINE_CHANNEL_ACCESS_TOKEN: TOKEN, LINE_CHANNEL_SECRET: SECRET },
    });
    adapters.push(a);
    return a;
  };

  beforeEach(async () => {
    server = new FakeServer();
    store = new MemoryGatewayStore();
    lineApi(server);
    await server.start();
  });

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.stop();
    await server.stop();
  });

  it("pushes a text message with a retry key and quick-reply postback buttons when no reply token is held", async () => {
    const adapter = make();
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.apiVersion).toMatch(/v2/);
    const receipt = await adapter.send({ channelId: ADA, text: "Deploy?", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny" }]] });
    expect(receipt).toEqual({ platform: "line", messageId: "500000000000001" });
    const [push] = server.find("POST", "/v2/bot/message/push");
    expect(push.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(push.headers["x-line-retry-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(push.json).toEqual({ to: ADA, messages: [{ type: "text", text: "Deploy?", quickReply: { items: [
      { type: "action", action: { type: "postback", label: "Approve", data: "trent:approve:appr_1:abcdef12", displayText: "Approve" } },
      { type: "action", action: { type: "postback", label: "Deny", data: "trent:deny:appr_1:abcdef12", displayText: "Deny" } },
    ] } }] });
  });

  it("refuses a webhook whose X-Line-Signature does not verify with 401, and routes nothing", async () => {
    const adapter = make();
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    const body = callback([textEvent("m1", "hello")]);
    expect((await adapter.handleWebhook({ ...signed(body), headers: { "x-line-signature": sign(body, "not-the-channel-secret") } })).status).toBe(401);
    expect((await adapter.handleWebhook({ ...signed(body), headers: {} })).status).toBe(401);
    expect((await adapter.handleWebhook({ ...signed(body), body: body.replace("hello", "HELLO") })).status).toBe(401);
    expect((await adapter.handleWebhook({ method: "GET", url: "/webhooks/line", headers: {}, body: "" })).status).toBe(405);
    const broken = "{not json";
    expect((await adapter.handleWebhook(signed(broken))).status).toBe(400);
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound).toEqual([]);
    expect(server.find("POST", "/v2/bot/message/")).toEqual([]);
  });

  it("routes a signed message, answers with its reply token once, then pushes; a stale token falls back to push", async () => {
    const adapter = make();
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    const ok = await adapter.handleWebhook(signed(callback([textEvent("m1", "hello trent")])));
    expect(ok.status).toBe(200);
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({
      id: "m1", platform: "line", channelId: ADA, senderId: ADA, content: "hello trent", scope: "dm", timestamp: new Date(1_700_000_000_000).toISOString(),
    }));
    await adapter.send({ channelId: ADA, text: "first answer" });
    expect(server.find("POST", "/v2/bot/message/reply")[0].json).toEqual({ replyToken: "rt-m1", messages: [{ type: "text", text: "first answer" }] });
    await adapter.send({ channelId: ADA, text: "second answer" });
    expect(server.find("POST", "/v2/bot/message/reply")).toHaveLength(1);
    expect(server.find("POST", "/v2/bot/message/push")[0].json).toEqual({ to: ADA, messages: [{ type: "text", text: "second answer" }] });

    server.on("POST", "/v2/bot/message/reply", (_r, res) => json(res, 400, { message: "Invalid reply token" }));
    await adapter.handleWebhook(signed(callback([textEvent("m2", "again")])));
    await waitFor(() => inbound.length === 2);
    await adapter.send({ channelId: ADA, text: "late answer" });
    expect(server.find("POST", "/v2/bot/message/push")[1].json).toEqual({ to: ADA, messages: [{ type: "text", text: "late answer" }] });
  });

  it("turns a postback into a button callback and acknowledges it with the postback's reply token", async () => {
    const adapter = make();
    const callbacks: ButtonCallback[] = [];
    adapter.onCallback(async (c) => { callbacks.push(c); return { ok: true, text: "Approved." }; });
    await adapter.start();
    const body = callback([event({ type: "postback", replyToken: "rt-pb", postback: { data: "trent:approve:appr_1:abcdef12" } })]);
    expect((await adapter.handleWebhook(signed(body))).status).toBe(200);
    await waitFor(() => server.find("POST", "/v2/bot/message/reply").length === 1);
    expect(callbacks[0]).toEqual(expect.objectContaining({ platform: "line", senderId: ADA, channelId: ADA, scope: "dm", actionId: "trent:approve:appr_1:abcdef12" }));
    expect(server.find("POST", "/v2/bot/message/reply")[0].json).toEqual({ replyToken: "rt-pb", messages: [{ type: "text", text: "Approved." }] });
  });

  it("routes a webhook event once: a redelivery, and the same event after a restart, are dropped by webhookEventId", async () => {
    const first = make();
    const inbound: InboundMessage[] = [];
    first.onMessage(async (m) => { inbound.push(m); });
    await first.start();
    const original = textEvent("m7", "only once");
    const redelivered = { ...original, deliveryContext: { isRedelivery: true } };
    await first.handleWebhook(signed(callback([original])));
    await first.handleWebhook(signed(callback([redelivered])));
    await waitFor(() => inbound.length === 1);
    await first.stop();
    expect(JSON.parse(store.snapshot().cursors["line.seen"] ?? "[]")).toContain(original.webhookEventId);

    const second = make();
    second.onMessage(async (m) => { inbound.push(m); });
    await second.start();
    expect((await second.handleWebhook(signed(callback([redelivered])))).status).toBe(200);
    await second.handleWebhook(signed(callback([textEvent("m8", "new one")])));
    await waitFor(() => inbound.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound.map((m) => m.id)).toEqual(["m7", "m8"]);
  });

  it("scopes a group message to the group, ignores standby events, and carries audio lazily from the data host", async () => {
    const M4A = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34]);
    server.on("GET", "/v2/bot/message/590000000000000001/content", (_r, res) => { res.writeHead(200, { "content-type": "audio/x-m4a" }); res.end(Buffer.from(M4A)); });
    const adapter = make();
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    const body = callback([
      textEvent("g1", "in the group", { source: { type: "group", groupId: GROUP, userId: ADA } }),
      textEvent("s1", "standby", { mode: "standby" }),
      event({ type: "message", replyToken: "rt-a1", message: { id: "590000000000000001", type: "audio", duration: 4200, contentProvider: { type: "line" } } }),
    ]);
    expect((await adapter.handleWebhook(signed(body))).status).toBe(200);
    await waitFor(() => inbound.length === 2);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "g1", channelId: GROUP, senderId: ADA, scope: "group" }));
    expect(inbound[1]).toEqual(expect.objectContaining({ id: "590000000000000001", content: "", attachments: [expect.objectContaining({ kind: "audio", durationSeconds: 4.2 })] }));
    expect(server.find("GET", "/v2/bot/message/")).toEqual([]);
    const res = await inbound[1].attachments![0].open!();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(M4A);
    expect(server.find("GET", "/v2/bot/message/590000000000000001/content")[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect((await adapter.health()).detail).toContain("Trent");
  });
});

describe("LINE through the GatewayManager and its WebhookServer", () => {
  let server: FakeServer;
  let tempDir: string;
  let manager: GatewayManager | undefined;
  let webhooks: WebhookServer | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-line-mgr-"));
    server = new FakeServer();
    lineApi(server);
    await server.start();
  });

  afterEach(async () => {
    await webhooks?.close();
    webhooks = undefined;
    await manager?.stopAll();
    manager = undefined;
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function make(handler?: (agentId: string, m: InboundMessage) => Promise<string | null>): Promise<{ m: GatewayManager; post: (body: string, signature?: string) => Promise<number> }> {
    const m = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new MemoryGatewayStore(),
      agentHandler: handler,
      adapterContext: { baseUrls: { line: server.baseUrl, "line-data": server.baseUrl }, settings: { LINE_CHANNEL_ACCESS_TOKEN: TOKEN, LINE_CHANNEL_SECRET: SECRET } },
      drainIntervalMs: 20,
    });
    manager = m;
    await m.getAdapter("line")!.start();
    webhooks = new WebhookServer(m);
    const port = await webhooks.listen(0);
    const post = async (body: string, signature = sign(body)) =>
      (await fetch(`http://127.0.0.1:${port}/webhooks/line`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signature }, body })).status;
    return { m, post };
  }
  const replies = () => server.find("POST", "/v2/bot/message/reply").map((r) => r.json as { replyToken: string; messages: Array<{ text: string }> });

  it("over HTTP: a forged post is 401 with no code sent; an unknown sender gets a pairing code; once paired the message is routed", async () => {
    const seen: Array<{ agentId: string; content: string }> = [];
    const { m, post } = await make(async (agentId, msg) => { seen.push({ agentId, content: msg.content }); return `answer from ${agentId}`; });
    m.setRoute("line", "support-responder");
    const hello = callback([textEvent("h1", "hello")]);
    expect(await post(hello, sign(hello, "forged-secret"))).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(replies()).toEqual([]);

    expect(await post(hello)).toBe(200);
    await waitFor(() => replies().length === 1);
    expect(replies()[0].replyToken).toBe("rt-h1");
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(replies()[0].messages[0].text)?.[1];
    expect(code).toBeDefined();
    expect(replies()[0].messages[0].text).toContain(`trent gateway pair line ${code}`);
    expect(seen).toEqual([]);

    m.getPairing().pair("line", code!, "regular");
    expect(await post(callback([textEvent("h2", "what is on today")]))).toBe(200);
    await waitFor(() => replies().length === 2);
    expect(seen).toEqual([{ agentId: "support-responder", content: "what is on today" }]);
    expect(replies()[1]).toEqual({ replyToken: "rt-h2", messages: [{ type: "text", text: "answer from support-responder" }] });
  });

  it("delivers an approval card with quick-reply buttons, and the admin's postback decides it", async () => {
    const { m, post } = await make();
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "line", senderId: ADA, scope: "dm", tier: "admin" });
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    expect((await m.sendApproval(req, "line", ADA)).sent).toBe(true);
    const card = server.find("POST", "/v2/bot/message/push")[0].json as { messages: Array<{ quickReply: { items: Array<{ action: { data: string } }> } }> };
    expect(card.messages[0].quickReply.items.map((i) => i.action.data)).toEqual([`trent:approve:${req.id}:${req.nonce}`, `trent:deny:${req.id}:${req.nonce}`]);
    expect(await post(callback([event({ type: "postback", replyToken: "rt-yes", postback: { data: `trent:approve:${req.id}:${req.nonce}` } })]))).toBe(200);
    await waitFor(() => bridge.getApproval(req.id)?.status === "approved");
    expect(bridge.getApproval(req.id)?.decidedBy).toBe(`line:${ADA}`);
    await waitFor(() => replies().length === 1);
    expect(replies()[0].messages[0].text).toBe(`Approved: Deploy to production (${req.id})`);
  });
});
