import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { GatewayManager } from "./GatewayManager.js";
import { WebhookServer } from "./WebhookServer.js";
import { FileGatewayStore, MemoryGatewayStore } from "./store/GatewayStore.js";
import { FakeServer, json, waitFor } from "./testing/fakeServer.js";
import type { InboundMessage } from "./transport/types.js";

const TOKEN = "777:telegram-token-for-gateway-test";

/** Feeds Telegram updates through the REAL adapter and Bot API wire shapes. */
function botApi(server: FakeServer, updates: unknown[][]) {
  let call = 0;
  server
    .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "T", username: "trent_bot" } }))
    .on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: updates[call++] ?? [] }))
    .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: 500 + server.find("POST", `/bot${TOKEN}/sendMessage`).length } }))
    .on("POST", `/bot${TOKEN}/answerCallbackQuery`, (_r, res) => json(res, 200, { ok: true, result: true }));
}

const tgMessage = (updateId: number, from: number, text: string) => ({ update_id: updateId, message: { message_id: updateId, from: { id: from, first_name: "Ada" }, chat: { id: from, type: "private" }, date: 1_700_000_000, text } });
const tgCallback = (updateId: number, from: number, data: string) => ({ update_id: updateId, callback_query: { id: `cb${updateId}`, from: { id: from, first_name: "Ada" }, message: { message_id: 1, chat: { id: from, type: "private" } }, data } });

describe("GatewayManager end to end over the Telegram wire", () => {
  let tempDir: string;
  let server: FakeServer;
  let manager: GatewayManager | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-mgr-"));
    server = new FakeServer();
  });

  afterEach(async () => {
    await manager?.stopAll();
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function make(updates: unknown[][], handler?: (agentId: string, m: InboundMessage) => Promise<string | null>) {
    botApi(server, updates);
    manager = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new MemoryGatewayStore(),
      agentHandler: handler,
      adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
      drainIntervalMs: 20,
    });
    return manager;
  }

  it("ignores an unpaired sender, offers a code once, then routes to the designated agent after pairing", async () => {
    await server.start();
    const seen: Array<{ agentId: string; content: string }> = [];
    const m = make(
      [[tgMessage(1, 555, "hello")], [tgMessage(2, 555, "hello again")]],
      async (agentId, msg) => { seen.push({ agentId, content: msg.content }); return `echo from ${agentId}`; },
    );
    m.setRoute("telegram", "support-responder");
    const started = await m.startAllConfigured();
    expect(started).toEqual(["telegram"]);
    await waitFor(() => server.find("POST", `/bot${TOKEN}/sendMessage`).length === 1);
    await new Promise((r) => setTimeout(r, 100)); // second update arrives; sender still unpaired
    expect(seen).toHaveLength(0);
    expect(server.find("POST", `/bot${TOKEN}/sendMessage`)).toHaveLength(1);
    const offer = server.find("POST", `/bot${TOKEN}/sendMessage`)[0].json as { chat_id: number; text: string };
    expect(offer.chat_id).toBe(555);
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(offer.text)?.[1];
    expect(code).toBeDefined();
    expect(offer.text).toContain(`trent gateway pair telegram ${code}`);

    m.getPairing().pair("telegram", code!, "regular");
    await m.handleInbound({ id: "x", platform: "telegram", channelId: "555", senderId: "555", content: "now paired", timestamp: "t", scope: "dm" });
    expect(seen).toEqual([{ agentId: "support-responder", content: "now paired" }]);
    await waitFor(() => server.find("POST", `/bot${TOKEN}/sendMessage`).length === 2);
    expect((server.find("POST", `/bot${TOKEN}/sendMessage`)[1].json as { text: string }).text).toBe("echo from support-responder");
    expect(m.getStatus().telegram).toEqual(expect.objectContaining({ configured: true, designatedAgent: "support-responder", pendingOutbound: 0 }));
    expect(m.getStatus().telegram.breaker.state).toBe("closed");
  });

  it("delivers an approval card, accepts the admin's button, rejects a forged one, and refuses a non-admin", async () => {
    await server.start();
    const bridge = (make([]) as GatewayManager).getApprovalBridge();
    const m = manager!;
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
    m.getPairing().grant({ platform: "telegram", senderId: "666", scope: "dm", tier: "regular" });
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    const out = await m.sendApproval(req, "telegram", "555");
    expect(out.sent).toBe(true);
    const card = server.find("POST", `/bot${TOKEN}/sendMessage`)[0].json as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toBe(`trent:approve:${req.id}:${req.nonce}`);

    const forged = await m.handleCallback({ platform: "telegram", callbackId: "c1", senderId: "555", channelId: "555", scope: "dm", actionId: `trent:approve:${req.id}:00000000` });
    expect(forged.ok).toBe(false);
    expect(bridge.getApproval(req.id)?.status).toBe("pending");
    const nonAdmin = await m.handleCallback({ platform: "telegram", callbackId: "c2", senderId: "666", channelId: "666", scope: "dm", actionId: `trent:approve:${req.id}:${req.nonce}` });
    expect(nonAdmin).toEqual({ ok: false, text: "You are not an approver on this platform." });
    // The genuine press arrives over the wire as a callback_query update.
    server.requests.length = 0;
    let served = false;
    server.on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: served ? [] : (served = true, [tgCallback(9, 555, `trent:approve:${req.id}:${req.nonce}`)]) }));
    await m.startAllConfigured();
    await waitFor(() => server.find("POST", `/bot${TOKEN}/answerCallbackQuery`).length === 1);
    expect((server.find("POST", `/bot${TOKEN}/answerCallbackQuery`)[0].json as { text: string }).text).toBe(`Approved: Deploy to production (${req.id})`);
    expect(bridge.getApproval(req.id)).toEqual(expect.objectContaining({ status: "approved", decidedBy: "telegram:555" }));
    const replay = await m.handleCallback({ platform: "telegram", callbackId: "c3", senderId: "555", channelId: "555", scope: "dm", actionId: `trent:approve:${req.id}:${req.nonce}` });
    expect(replay).toEqual({ ok: false, text: "No matching pending approval." });
  });

  it("records where the approval card was delivered, so a reaction on that message decides it", async () => {
    await server.start();
    const m = make([]);
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    const out = await m.sendApproval(req, "telegram", "555");
    expect(out.sent).toBe(true);
    // The Bot API answered sendMessage with message_id 501 (the fake numbers replies from 500 + count).
    expect(bridge.getApproval(req.id)?.deliveredTo).toEqual([{ platform: "telegram", channelId: "555", messageId: "501" }]);
    const stranger = bridge.resolveReaction({ platform: "telegram", channelId: "555", messageId: "501", emoji: "\u{1F44D}", senderId: "999", scope: "dm" });
    expect(stranger).toEqual({ ok: false, reason: "not_admin" });
    const decided = bridge.resolveReaction({ platform: "telegram", channelId: "555", messageId: "501", emoji: "\u{1F44D}", senderId: "555", scope: "dm" });
    expect(decided).toEqual(expect.objectContaining({ ok: true, decision: "approved" }));
    expect(bridge.getApproval(req.id)).toEqual(expect.objectContaining({ status: "approved", decidedBy: "telegram:555" }));
  });

  it("treats an APPROVE reply from a paired email admin as the decision, and ignores it from a stranger", async () => {
    const m = make([]);
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
    const req = bridge.createApprovalRequest("ceo", "Refund", {});
    const reply = (from: string) => ({ id: "<r@x>", platform: "email", channelId: from, senderId: from, content: `APPROVE ${req.id} ${req.nonce}\n> quoted`, timestamp: "t", scope: "dm" as const, metadata: { subject: "Re: Approval" } });
    await m.handleInbound(reply("stranger@example.com"));
    expect(bridge.getApproval(req.id)?.status).toBe("pending");
    await m.handleInbound(reply("ops@example.com"));
    expect(bridge.getApproval(req.id)).toEqual(expect.objectContaining({ status: "approved", decidedBy: "email:ops@example.com" }));
    // No SMTP server is configured here, so both outbound rows stay pending, never lost:
    // the pairing-code offer to the stranger and the decision ack to the admin.
    const pending = m.getQueue().pending("email").map((r) => [r.message.channelId, r.message.text.split("\n")[0]]);
    expect(pending).toEqual([
      ["stranger@example.com", expect.stringContaining("not paired")],
      ["ops@example.com", `Approved: Refund (${req.id})`],
    ]);
  });

  it("keeps a reply on disk when the platform is down and sends it from a fresh process", async () => {
    const file = path.join(tempDir, "gateway.json");
    botApi(server, []);
    const first = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new FileGatewayStore(file),
      adapterContext: { baseUrls: { telegram: "http://127.0.0.1:1" }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
      queue: { breaker: { failureThreshold: 1, baseBackoffMs: 60_000, maxBackoffMs: 60_000 } },
    });
    const r = await first.send("telegram", { channelId: "555", text: "do not lose me" });
    expect(r.sent).toBe(false);
    expect(first.getStatus().telegram.breaker.state).toBe("open");
    expect(first.getStatus().telegram.pendingOutbound).toBe(1);
    await server.start();
    manager = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new FileGatewayStore(file),
      adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
    });
    expect(manager.getStatus().telegram.pendingOutbound).toBe(1);
    const drained = await manager.getQueue().drain();
    expect(drained.sent).toBe(1);
    expect((server.find("POST", `/bot${TOKEN}/sendMessage`)[0].json as { text: string }).text).toBe("do not lose me");
  });

  it("serves /webhooks/<platform> and 404s unknown platforms", async () => {
    await server.start();
    const m = make([]);
    const web = new WebhookServer(m);
    const port = await web.listen(0);
    try {
      const nope = await fetch(`http://127.0.0.1:${port}/webhooks/pigeon`, { method: "POST", body: "{}" });
      expect(nope.status).toBe(404);
      const forbidden = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, { method: "POST", body: "{}" });
      expect(forbidden.status).toBe(403);
    } finally {
      await web.close();
    }
  });

  it("persists routes through the config file", () => {
    const cfg = new ConfigManager({ baseDir: tempDir });
    const a = new GatewayManager(cfg, { store: new MemoryGatewayStore() });
    a.setRoute("slack", "ceo");
    a.setRoute("discord", "eng-ai-engineer");
    const b = new GatewayManager(new ConfigManager({ baseDir: tempDir }), { store: new MemoryGatewayStore() });
    expect(b.getAgentForPlatform("slack")).toBe("ceo");
    expect(b.getAgentForPlatform("discord")).toBe("eng-ai-engineer");
    expect(() => b.setRoute("pigeon", "ceo")).toThrow(/Unknown platform/);
  });
});

describe("GatewayManager double-texting policy", () => {
  let tempDir: string;
  beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-dt-")); });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  const inbound = (channelId: string, content: string, id = content): InboundMessage =>
    ({ id, platform: "email", channelId, senderId: channelId, content, timestamp: "t", scope: "dm" });

  /** An agent handler whose turns finish only when the test says so, logging start/end. */
  function slowHandler(log: string[]) {
    const finishers = new Map<string, () => void>();
    const handler = async (_agentId: string, m: InboundMessage, signal?: AbortSignal): Promise<string> => {
      log.push(`${m.content}:start`);
      await new Promise<void>((resolve) => {
        finishers.set(m.content, resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      log.push(`${m.content}:end${signal?.aborted ? ":aborted" : ""}`);
      return `re ${m.content}`;
    };
    return { handler, finish: (content: string) => finishers.get(content)?.() };
  }

  function build(policy: "enqueue" | "interrupt" | "reject", handler: (a: string, m: InboundMessage, s?: AbortSignal) => Promise<string | null>) {
    const cfg = new ConfigManager({ baseDir: tempDir });
    const config = cfg.loadConfig();
    config.gateway = { ...config.gateway, double_text_policy: policy };
    cfg.saveConfig(config);
    const m = new GatewayManager(cfg, { store: new MemoryGatewayStore(), agentHandler: handler });
    m.getPairing().grant({ platform: "email", senderId: "a@example.com", scope: "dm", tier: "regular" });
    m.getPairing().grant({ platform: "email", senderId: "b@example.com", scope: "dm", tier: "regular" });
    return m;
  }

  it("enqueue: two messages on one chat run one after the other; on different chats they overlap", async () => {
    const log: string[] = [];
    const slow = slowHandler(log);
    const m = build("enqueue", slow.handler);
    const first = m.handleInbound(inbound("a@example.com", "one"));
    const second = m.handleInbound(inbound("a@example.com", "two"));
    const other = m.handleInbound(inbound("b@example.com", "three"));
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["one:start", "three:start"]);
    slow.finish("one");
    await first;
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["one:start", "three:start", "one:end", "two:start"]);
    slow.finish("three");
    slow.finish("two");
    await Promise.all([second, other]);
    const texts = m.getQueue().pending("email").map((r) => r.message.text);
    expect(texts).toEqual(["re one", "re three", "re two"]);
  });

  it("interrupt: the second message aborts the first turn's signal and then runs", async () => {
    const log: string[] = [];
    const slow = slowHandler(log);
    const m = build("interrupt", slow.handler);
    const first = m.handleInbound(inbound("a@example.com", "one"));
    await new Promise((r) => setTimeout(r, 5));
    const second = m.handleInbound(inbound("a@example.com", "two"));
    await first;
    await new Promise((r) => setTimeout(r, 5));
    expect(log).toEqual(["one:start", "one:end:aborted", "two:start"]);
    slow.finish("two");
    await second;
    expect(log.at(-1)).toBe("two:end");
  });

  it("reject: a message during a turn gets the status line and never reaches the agent", async () => {
    const log: string[] = [];
    const slow = slowHandler(log);
    const m = build("reject", slow.handler);
    const first = m.handleInbound(inbound("a@example.com", "one"));
    await new Promise((r) => setTimeout(r, 5));
    await m.handleInbound(inbound("a@example.com", "two"));
    expect(log).toEqual(["one:start"]);
    const rows = m.getQueue().pending("email");
    expect(rows).toHaveLength(1);
    expect(rows[0].message.channelId).toBe("a@example.com");
    expect(rows[0].message.text).not.toContain("re two");
    slow.finish("one");
    await first;
    expect(log).toEqual(["one:start", "one:end"]);
  });

  it("/stop interrupts the running turn under enqueue and starts nothing", async () => {
    const log: string[] = [];
    const slow = slowHandler(log);
    const m = build("enqueue", slow.handler);
    const first = m.handleInbound(inbound("a@example.com", "one"));
    await new Promise((r) => setTimeout(r, 5));
    await m.handleInbound(inbound("a@example.com", "/stop"));
    await first;
    expect(log).toEqual(["one:start", "one:end:aborted"]);
  });
});
