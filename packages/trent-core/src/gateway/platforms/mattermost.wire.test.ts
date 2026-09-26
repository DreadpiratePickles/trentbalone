/**
 * [H4] MattermostAdapter against a local server speaking the Mattermost API v4
 * (https://api.mattermost.com/): REST for posts, reactions, users/me, channels and files, and the
 * WebSocket at /api/v4/websocket authenticated with an `authentication_challenge` frame. The
 * pairing gate and the reaction-decided approval are proven through the real GatewayManager.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ConfigManager } from "../../config/ConfigManager.js";
import { GatewayManager } from "../GatewayManager.js";
import { MattermostAdapter } from "./mattermost.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage, InboundReaction } from "../transport/types.js";

const TOKEN = "fake-mattermost-bot-token-9x8y7z";
const BOT = "botuserid00000000000000000";
const ADA = "adauserid000000000000000000";
const DM = "dmchannelid0000000000000000";
const TOWN = "townsquareid000000000000000";

interface Post { id: string; create_at: number; user_id: string; channel_id: string; root_id?: string; message: string; type?: string; metadata?: Record<string, unknown> }
const post = (p: Partial<Post> & { id: string; message: string }): Post => ({ create_at: 1_700_000_000_000, user_id: ADA, channel_id: DM, root_id: "", type: "", ...p });

/** The server half: REST routes plus a WebSocket on the same origin, the way Mattermost serves both. */
class FakeMattermost {
  readonly http = new FakeServer();
  readonly frames: unknown[] = [];
  private wss?: WebSocketServer;
  private sockets: WebSocket[] = [];
  private seq = 0;
  private created = 0;

  async start(): Promise<void> {
    this.http
      .on("GET", "/api/v4/users/me", (_r, res) => json(res, 200, { id: BOT, username: "trent" }))
      .on("POST", "/api/v4/posts", (req, res) => json(res, 201, { id: `post${++this.created}`, create_at: Date.now(), ...(req.json as object) }))
      .on("POST", "/api/v4/reactions", (req, res) => json(res, 201, req.json))
      .on("GET", `/api/v4/channels/${DM}`, (_r, res) => json(res, 200, { id: DM, type: "D" }))
      .on("GET", `/api/v4/channels/${TOWN}`, (_r, res) => json(res, 200, { id: TOWN, type: "O" }));
    await this.http.start();
    this.wss = new WebSocketServer({ server: this.http.httpServer, path: "/api/v4/websocket" });
    this.wss.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { seq: number; action: string; data: { token?: string } };
        this.frames.push(frame);
        if (frame.action !== "authentication_challenge") return;
        if (frame.data.token !== TOKEN) { socket.close(); return; }
        socket.send(JSON.stringify({ status: "OK", seq_reply: frame.seq }));
        socket.send(JSON.stringify({ event: "hello", data: { server_version: "10.6.0" }, broadcast: { user_id: BOT, channel_id: "", team_id: "" }, seq: this.seq++ }));
      });
    });
  }

  get connected(): boolean {
    return this.sockets.some((s) => s.readyState === s.OPEN);
  }

  posted(p: Post, channelType = "D"): void {
    this.emit({ event: "posted", data: { channel_type: channelType, post: JSON.stringify(p), sender_name: "@ada" }, broadcast: { channel_id: p.channel_id } });
  }

  reacted(userId: string, postId: string, emoji: string, channelId = DM): void {
    this.emit({ event: "reaction_added", data: { reaction: JSON.stringify({ user_id: userId, post_id: postId, emoji_name: emoji, create_at: Date.now() }) }, broadcast: { channel_id: channelId } });
  }

  private emit(frame: Record<string, unknown>): void {
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify({ ...frame, seq: this.seq++ }));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await this.http.stop();
  }
}

describe("MattermostAdapter against a local API v4 server", () => {
  let mm: FakeMattermost;
  let store: MemoryGatewayStore;
  const adapters: MattermostAdapter[] = [];

  const make = () => {
    const a = new MattermostAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store,
      baseUrls: { mattermost: mm.http.baseUrl },
      settings: { MATTERMOST_URL: "https://chat.example.com", MATTERMOST_BOT_TOKEN: TOKEN },
    });
    adapters.push(a);
    return a;
  };

  beforeEach(async () => {
    mm = new FakeMattermost();
    store = new MemoryGatewayStore();
    await mm.start();
  });

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.stop();
    await mm.stop();
  });

  it("creates posts with a Bearer token, replies in a thread with root_id, renders buttons as text, and reacts", async () => {
    const adapter = make();
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.apiVersion).toMatch(/v4/);
    const receipt = await adapter.send({ channelId: DM, text: "Deploy?", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }]] });
    expect(receipt).toEqual({ platform: "mattermost", messageId: "post1" });
    const [first] = mm.http.find("POST", "/api/v4/posts");
    expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first.json).toEqual({ channel_id: DM, message: "Deploy?\n\n[Approve] trent:approve:appr_1:abcdef12" });
    await adapter.send({ channelId: TOWN, text: "in the thread", threadId: "rootpost" });
    expect(mm.http.find("POST", "/api/v4/posts")[1].json).toEqual({ channel_id: TOWN, message: "in the thread", root_id: "rootpost" });
    await adapter.react("post1", "white_check_mark");
    expect(mm.http.find("POST", "/api/v4/reactions")[0].json).toEqual({ user_id: BOT, post_id: "post1", emoji_name: "white_check_mark" });
  });

  it("authenticates the WebSocket with the challenge frame and delivers posts, skipping its own and system posts", async () => {
    const inbound: InboundMessage[] = [];
    const adapter = make();
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => mm.connected && mm.frames.length === 1);
    expect(mm.frames[0]).toEqual({ seq: 1, action: "authentication_challenge", data: { token: TOKEN } });
    mm.posted(post({ id: "own1", user_id: BOT, message: "my own post", create_at: 1_700_000_000_001 }));
    mm.posted(post({ id: "sys1", message: "ada joined", type: "system_join_channel", create_at: 1_700_000_000_002 }));
    mm.posted(post({ id: "p1", message: "hello trent", create_at: 1_700_000_000_003 }));
    mm.posted(post({ id: "p2", channel_id: TOWN, root_id: "rootpost", message: "in a thread", create_at: 1_700_000_000_004 }), "O");
    await waitFor(() => inbound.length === 2);
    expect(inbound[0]).toEqual(expect.objectContaining({
      id: "p1", platform: "mattermost", channelId: DM, senderId: ADA, senderName: "ada", content: "hello trent", scope: "dm",
      timestamp: new Date(1_700_000_000_003).toISOString(),
    }));
    expect(inbound[0].threadId).toBeUndefined();
    expect(inbound[1]).toEqual(expect.objectContaining({ id: "p2", channelId: TOWN, scope: "group", threadId: "rootpost" }));
    const health = await adapter.health();
    expect(health.state).toBe("up");
    expect(health.detail).toContain("trent");
  });

  it("surfaces reaction_added as an InboundReaction scoped by the channel's type, and ignores its own", async () => {
    const reactions: InboundReaction[] = [];
    const adapter = make();
    adapter.onReaction(async (r) => { reactions.push(r); });
    await adapter.start();
    await waitFor(() => mm.connected && mm.frames.length === 1);
    mm.reacted(BOT, "card1", "eyes");
    mm.reacted(ADA, "card1", "+1");
    mm.reacted(ADA, "card2", "x", TOWN);
    await waitFor(() => reactions.length === 2);
    expect(reactions).toEqual([
      { platform: "mattermost", channelId: DM, messageId: "card1", emoji: "+1", senderId: ADA, scope: "dm" },
      { platform: "mattermost", channelId: TOWN, messageId: "card2", emoji: "x", senderId: ADA, scope: "group" },
    ]);
  });

  it("persists the last post it handled, so a restart never replays a post the server sends again", async () => {
    const first: InboundMessage[] = [];
    const a = make();
    a.onMessage(async (m) => { first.push(m); });
    await a.start();
    await waitFor(() => mm.connected);
    mm.posted(post({ id: "p1", message: "once", create_at: 1_700_000_000_100 }));
    await waitFor(() => first.length === 1);
    await a.stop();
    expect(store.snapshot().cursors["mattermost.last"]).toBe("1700000000100:p1");

    const second: InboundMessage[] = [];
    const b = make();
    b.onMessage(async (m) => { second.push(m); });
    await b.start();
    await waitFor(() => mm.frames.length === 2);
    mm.posted(post({ id: "p1", message: "once", create_at: 1_700_000_000_100 }));
    mm.posted(post({ id: "p0", message: "older", create_at: 1_700_000_000_050 }));
    mm.posted(post({ id: "p2", message: "twice? no, new", create_at: 1_700_000_000_200 }));
    await waitFor(() => second.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.map((m) => m.id)).toEqual(["p2"]);
    expect(store.snapshot().cursors["mattermost.last"]).toBe("1700000000200:p2");
  });

  it("carries an audio file as a lazy attachment, fetched from /api/v4/files with the token only when opened", async () => {
    const M4A = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    mm.http.on("GET", "/api/v4/files/voicefile1", (_r, res) => { res.writeHead(200, { "content-type": "audio/mp4" }); res.end(Buffer.from(M4A)); });
    const inbound: InboundMessage[] = [];
    const adapter = make();
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => mm.connected && mm.frames.length === 1);
    mm.posted(post({ id: "v1", message: "", metadata: { files: [{ id: "img1", name: "a.png", mime_type: "image/png", size: 3 }, { id: "voicefile1", name: "note.m4a", mime_type: "audio/mp4", size: M4A.length }] } }));
    await waitFor(() => inbound.length === 1);
    expect(inbound[0].attachments).toEqual([expect.objectContaining({ kind: "audio", mime: "audio/mp4", sizeBytes: M4A.length })]);
    expect(mm.http.find("GET", "/api/v4/files/")).toEqual([]);
    const res = await inbound[0].attachments![0].open!();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(M4A);
    expect(mm.http.find("GET", "/api/v4/files/voicefile1")[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("Mattermost through the GatewayManager: pairing before routing, approvals by reaction", () => {
  let mm: FakeMattermost;
  let tempDir: string;
  let manager: GatewayManager | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mm-mgr-"));
    mm = new FakeMattermost();
    await mm.start();
  });

  afterEach(async () => {
    await manager?.stopAll();
    manager = undefined;
    await mm.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function make(handler?: (agentId: string, m: InboundMessage) => Promise<string | null>): GatewayManager {
    manager = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new MemoryGatewayStore(),
      agentHandler: handler,
      adapterContext: { baseUrls: { mattermost: mm.http.baseUrl }, settings: { MATTERMOST_URL: "https://chat.example.com", MATTERMOST_BOT_TOKEN: TOKEN } },
      drainIntervalMs: 20,
    });
    return manager;
  }
  const created = () => mm.http.find("POST", "/api/v4/posts").map((r) => r.json as { channel_id: string; message: string; root_id?: string });

  it("an unknown sender gets a pairing code and no run; once paired, a thread reply is routed and answered in the thread", async () => {
    const seen: Array<{ agentId: string; content: string }> = [];
    const m = make(async (agentId, msg) => { seen.push({ agentId, content: msg.content }); return `answer from ${agentId}`; });
    m.setRoute("mattermost", "support-responder");
    await m.getAdapter("mattermost")!.start();
    await waitFor(() => mm.connected && mm.frames.length === 1);
    mm.posted(post({ id: "h1", message: "hello", create_at: 1_700_000_000_001 }));
    await waitFor(() => created().length === 1);
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(created()[0].message)?.[1];
    expect(code).toBeDefined();
    expect(created()[0]).toEqual(expect.objectContaining({ channel_id: DM }));
    expect(created()[0].message).not.toContain("trent "); // [C7] the stranger is shown no command; the owner pairs from `gateway pairings`
    expect(seen).toEqual([]);

    m.getPairing().pair("mattermost", code!, "regular");
    mm.posted(post({ id: "h2", root_id: "h1", message: "what is on today", create_at: 1_700_000_000_002 }));
    await waitFor(() => created().length === 2);
    expect(seen).toEqual([{ agentId: "support-responder", content: "what is on today" }]);
    expect(created()[1]).toEqual({ channel_id: DM, message: "answer from support-responder", root_id: "h1" });
  });

  it("delivers an approval card with the reply line, and the admin's +1 reaction on that post decides it", async () => {
    const m = make();
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "mattermost", senderId: ADA, scope: "dm", tier: "admin" });
    await m.getAdapter("mattermost")!.start();
    await waitFor(() => mm.connected && mm.frames.length === 1);
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    expect((await m.sendApproval(req, "mattermost", DM)).sent).toBe(true);
    expect(created()[0].message).toContain(`APPROVE ${req.id} ${req.nonce}`);
    expect(bridge.getApproval(req.id)?.deliveredTo).toEqual([{ platform: "mattermost", channelId: DM, messageId: "post1" }]);
    mm.reacted("strangerid0000000000000000", "post1", "+1");
    mm.reacted(ADA, "post1", "+1");
    await waitFor(() => bridge.getApproval(req.id)?.status === "approved");
    expect(bridge.getApproval(req.id)?.decidedBy).toBe(`mattermost:${ADA}`);
  });
});
