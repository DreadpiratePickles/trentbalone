/**
 * [H4] MatrixAdapter against a local homeserver speaking the client-server API
 * (https://spec.matrix.org/v1.11/client-server-api/): /sync long-polling with a since token,
 * m.room.message and m.reaction over PUT .../send/{eventType}/{txnId}, invites joined, and the
 * pairing gate proven through the real GatewayManager.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { GatewayManager } from "../GatewayManager.js";
import { MatrixAdapter } from "./matrix.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor, type RecordedRequest } from "../testing/fakeServer.js";
import type { InboundMessage, InboundReaction } from "../transport/types.js";

const TOKEN = "syt_dHJlbnQ_fake_matrix_access_token_0001";
const SELF = "@trent:example.org";
const ADA = "@ada:example.org";
const DM = "!dm:example.org";
const TEAM = "!team:example.org";
const SEND_RE = /^\/_matrix\/client\/v3\/rooms\/[^/]+\/send\/[^/]+\/[^/]+$/;

type Batch = Record<string, unknown>;
const text = (id: string, sender: string, body: string, extra: Record<string, unknown> = {}) =>
  ({ type: "m.room.message", event_id: id, sender, origin_server_ts: 1_700_000_000_000, content: { msgtype: "m.text", body, ...extra } });
const joined = (roomId: string, events: unknown[], summary?: Record<string, number>): Batch =>
  ({ rooms: { join: { [roomId]: { ...(summary ? { summary } : {}), timeline: { events } } } } });

/**
 * /sync keyed by the since token, the way a homeserver answers it: no token is the initial sync
 * (recent history), `s<n>` returns `batches[n]` with `next_batch: s<n+1>`, or holds briefly and
 * returns the same token when nothing new has happened.
 */
function homeserver(server: FakeServer, batches: Batch[], history: unknown[] = []): Array<string | null> {
  const syncs: Array<string | null> = [];
  server.on("GET", "/_matrix/client/v3/sync", async (req, res) => {
    const since = new URL(req.path, "http://hs").searchParams.get("since");
    syncs.push(since);
    if (since === null) return json(res, 200, { next_batch: "s0", ...joined(DM, history, { "m.joined_member_count": 2 }) });
    const n = Number(since.slice(1));
    const next = batches[n];
    if (next === undefined) {
      await new Promise((r) => setTimeout(r, 30));
      return json(res, 200, { next_batch: since });
    }
    return json(res, 200, { ...next, next_batch: `s${n + 1}` });
  });
  return syncs;
}

describe("MatrixAdapter against a local homeserver", () => {
  let server: FakeServer;
  let store: MemoryGatewayStore;
  const adapters: MatrixAdapter[] = [];
  let sent = 0;

  const make = () => {
    const a = new MatrixAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store,
      baseUrls: { matrix: server.baseUrl },
      settings: { MATRIX_HOMESERVER_URL: "https://matrix.example.org", MATRIX_ACCESS_TOKEN: TOKEN },
    });
    adapters.push(a);
    return a;
  };
  const sends = (): RecordedRequest[] => server.requests.filter((r) => r.method === "PUT" && SEND_RE.test(r.path));

  beforeEach(async () => {
    server = new FakeServer();
    store = new MemoryGatewayStore();
    sent = 0;
    server
      .on("GET", "/_matrix/client/v3/account/whoami", (_r, res) => json(res, 200, { user_id: SELF, device_id: "TRENTDEV" }))
      .on("PUT", SEND_RE, (_r, res) => json(res, 200, { event_id: `$sent${++sent}` }))
      .on("POST", /^\/_matrix\/client\/v3\/rooms\/[^/]+\/join$/, (req, res) => json(res, 200, { room_id: decodeURIComponent(req.path.split("/")[5]!) }))
      .on("GET", /^\/_matrix\/client\/v3\/rooms\/[^/]+\/joined_members$/, (_r, res) => json(res, 200, { joined: { [ADA]: {}, [SELF]: {}, "@bo:example.org": {} } }));
    await server.start();
  });

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.stop();
    await server.stop();
  });

  it("is configured from the homeserver URL and token, sends m.room.message with a Bearer token, and replies in a thread", async () => {
    const adapter = make();
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.apiVersion).toMatch(/v3/);
    const receipt = await adapter.send({ channelId: DM, text: "Deploy?", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }]] });
    expect(receipt).toEqual({ platform: "matrix", messageId: "$sent1" });
    const [first] = sends();
    expect(first.path).toMatch(/^\/_matrix\/client\/v3\/rooms\/!dm%3Aexample\.org\/send\/m\.room\.message\/[^/]+$/);
    expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first.json).toEqual({ msgtype: "m.text", body: "Deploy?\n\n[Approve] trent:approve:appr_1:abcdef12" });

    await adapter.send({ channelId: DM, text: "in the thread", threadId: "$root" });
    const [, threaded] = sends();
    expect(threaded.json).toEqual({
      msgtype: "m.text", body: "in the thread",
      "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: "$root" } },
    });
    // Two sends, two transaction ids: a retried PUT with the same id is deduplicated by the server.
    expect(first.path.split("/").pop()).not.toBe(threaded.path.split("/").pop());

    await adapter.react(DM, "$target", "\u{1F44D}");
    const [, , reaction] = sends();
    expect(reaction.path).toMatch(/\/send\/m\.reaction\//);
    expect(reaction.json).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "\u{1F44D}" } });
  });

  it("long-polls /sync, skips the initial history, persists next_batch, and a restart resumes from it without replaying", async () => {
    const batches: Batch[] = [joined(DM, [text("$m1", ADA, "hello trent"), text("$own", SELF, "my own echo"), text("$notice", "@bot:example.org", "beep", { msgtype: "m.notice" })])];
    const syncs = homeserver(server, batches, [text("$old", ADA, "yesterday")]);
    const first: InboundMessage[] = [];
    const a = make();
    a.onMessage(async (m) => { first.push(m); });
    await a.start();
    await waitFor(() => first.length === 1 && syncs.length >= 3);
    expect(first[0]).toEqual(expect.objectContaining({
      id: "$m1", platform: "matrix", channelId: DM, senderId: ADA, content: "hello trent", scope: "dm",
      timestamp: new Date(1_700_000_000_000).toISOString(),
    }));
    const initial = server.find("GET", "/_matrix/client/v3/sync")[0];
    expect(new URL(initial.path, "http://hs").searchParams.get("timeout")).toBe("0");
    expect(initial.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await a.stop();
    expect(store.snapshot().cursors["matrix.since"]).toBe("s1");

    // Sent while the gateway was down; the restarted adapter resumes from s1 and gets only this one.
    batches.push(joined(DM, [text("$m2", ADA, "while you were out")]));
    syncs.length = 0;
    const second: InboundMessage[] = [];
    const b = make();
    b.onMessage(async (m) => { second.push(m); });
    await b.start();
    await waitFor(() => second.length === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(syncs[0]).toBe("s1");
    expect(second.map((m) => m.id)).toEqual(["$m2"]);
    expect(store.snapshot().cursors["matrix.since"]).toBe("s2");
  });

  it("joins a room it is invited to, reads the room size for scope, and threads a thread reply's id", async () => {
    const inbound: InboundMessage[] = [];
    homeserver(server, [
      { rooms: { invite: { [TEAM]: { invite_state: { events: [] } } } } },
      joined(TEAM, [text("$g1", ADA, "in the team room", { "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: "$root" } } })]),
    ]);
    const adapter = make();
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 1);
    expect(server.find("POST", "/_matrix/client/v3/rooms/!team%3Aexample.org/join")).toHaveLength(1);
    expect(server.find("GET", "/_matrix/client/v3/rooms/!team%3Aexample.org/joined_members")).toHaveLength(1);
    expect(inbound[0]).toEqual(expect.objectContaining({ channelId: TEAM, scope: "group", threadId: "$root", content: "in the team room" }));
  });

  it("surfaces an m.annotation reaction as an InboundReaction, and ignores its own", async () => {
    const reactions: InboundReaction[] = [];
    const annotate = (id: string, sender: string, key: string) => ({ type: "m.reaction", event_id: id, sender, origin_server_ts: 1, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$card", key } } });
    homeserver(server, [joined(DM, [annotate("$r1", ADA, "\u{1F44D}"), annotate("$r2", SELF, "\u{1F440}")], { "m.joined_member_count": 2 })]);
    const adapter = make();
    adapter.onReaction(async (r) => { reactions.push(r); });
    await adapter.start();
    await waitFor(() => reactions.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(reactions).toEqual([{ platform: "matrix", channelId: DM, messageId: "$card", emoji: "\u{1F44D}", senderId: ADA, scope: "dm" }]);
    const health = await adapter.health();
    expect(health.state).toBe("up");
    expect(health.detail).toContain(SELF);
  });

  it("carries an m.audio message as a lazy attachment, downloaded from the homeserver's authenticated media only when opened", async () => {
    const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 7]);
    server.on("GET", "/_matrix/client/v1/media/download/example.org/VoiceAbC123", (_r, res) => { res.writeHead(200, { "content-type": "audio/ogg" }); res.end(Buffer.from(OGG)); });
    const inbound: InboundMessage[] = [];
    homeserver(server, [joined(DM, [{ type: "m.room.message", event_id: "$v1", sender: ADA, origin_server_ts: 1, content: { msgtype: "m.audio", body: "Voice message", url: "mxc://example.org/VoiceAbC123", info: { mimetype: "audio/ogg", size: OGG.length, duration: 4200 } } }])]);
    const adapter = make();
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "$v1", content: "", attachments: [expect.objectContaining({ kind: "audio", mime: "audio/ogg", sizeBytes: OGG.length, durationSeconds: 4.2 })] }));
    expect(server.find("GET", "/_matrix/client/v1/media/download/")).toEqual([]);
    const res = await inbound[0].attachments![0].open!();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(OGG);
    expect(server.find("GET", "/_matrix/client/v1/media/download/")[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("Matrix through the GatewayManager: pairing before routing, approvals by reaction", () => {
  let server: FakeServer;
  let tempDir: string;
  let manager: GatewayManager | undefined;
  let sent = 0;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-matrix-mgr-"));
    server = new FakeServer();
    sent = 0;
    server
      .on("GET", "/_matrix/client/v3/account/whoami", (_r, res) => json(res, 200, { user_id: SELF }))
      .on("PUT", SEND_RE, (_r, res) => json(res, 200, { event_id: `$sent${++sent}` }));
    await server.start();
  });

  afterEach(async () => {
    await manager?.stopAll();
    manager = undefined;
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function make(handler?: (agentId: string, m: InboundMessage) => Promise<string | null>): GatewayManager {
    manager = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new MemoryGatewayStore(),
      agentHandler: handler,
      adapterContext: { baseUrls: { matrix: server.baseUrl }, settings: { MATRIX_HOMESERVER_URL: "https://matrix.example.org", MATRIX_ACCESS_TOKEN: TOKEN } },
      drainIntervalMs: 20,
    });
    return manager;
  }
  const bodies = () => server.requests.filter((r) => r.method === "PUT" && SEND_RE.test(r.path)).map((r) => r.json as { body?: string; "m.relates_to"?: unknown });

  it("an unknown sender gets a pairing code and no run; once paired, a threaded message is routed and answered in the thread", async () => {
    const batches: Batch[] = [];
    homeserver(server, batches);
    const seen: Array<{ agentId: string; content: string }> = [];
    const m = make(async (agentId, msg) => { seen.push({ agentId, content: msg.content }); return `answer from ${agentId}`; });
    m.setRoute("matrix", "support-responder");
    await m.getAdapter("matrix")!.start();
    batches.push(joined(DM, [text("$h1", ADA, "hello")], { "m.joined_member_count": 2 }));
    await waitFor(() => bodies().length === 1);
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(bodies()[0].body ?? "")?.[1];
    expect(code).toBeDefined();
    expect(bodies()[0].body).toContain(`trent gateway pair matrix ${code}`);
    expect(seen).toEqual([]);

    m.getPairing().pair("matrix", code!, "regular");
    const inThread = { "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: "$root" } } };
    batches.push(joined(DM, [text("$h2", ADA, "what is on today", inThread)]));
    await waitFor(() => bodies().length === 2);
    expect(seen).toEqual([{ agentId: "support-responder", content: "what is on today" }]);
    expect(bodies()[1]).toEqual({ msgtype: "m.text", body: "answer from support-responder", ...inThread });
  });

  it("delivers an approval card as text with the reply line, and the admin's thumbs-up reaction on it decides", async () => {
    const batches: Batch[] = [];
    homeserver(server, batches);
    const m = make();
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "matrix", senderId: ADA, scope: "dm", tier: "admin" });
    await m.getAdapter("matrix")!.start();
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    const out = await m.sendApproval(req, "matrix", DM);
    expect(out.sent).toBe(true);
    expect(bodies()[0].body).toContain(`APPROVE ${req.id} ${req.nonce}`);
    expect(bridge.getApproval(req.id)?.deliveredTo).toEqual([{ platform: "matrix", channelId: DM, messageId: "$sent1" }]);
    batches.push(joined(DM, [{ type: "m.reaction", event_id: "$r9", sender: ADA, origin_server_ts: 1, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$sent1", key: "\u{1F44D}️" } } }], { "m.joined_member_count": 2 }));
    await waitFor(() => bridge.getApproval(req.id)?.status === "approved");
    expect(bridge.getApproval(req.id)?.decidedBy).toBe(`matrix:${ADA}`);
  });
});
