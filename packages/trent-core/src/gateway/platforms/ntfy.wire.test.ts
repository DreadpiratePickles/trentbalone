/**
 * [H4] NtfyAdapter against a local server speaking the ntfy HTTP API (https://docs.ntfy.sh/):
 * publish as JSON to the root URL, `http` action buttons, the `<topic>/json` stream with `since=`,
 * access tokens as a Bearer header, and `/v1/health`. The reply topic is the sender: pairing and
 * the approval tap are proven through the real GatewayManager.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { ConfigManager } from "../../config/ConfigManager.js";
import { GatewayManager } from "../GatewayManager.js";
import { NtfyAdapter } from "./ntfy.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

const TOKEN = "tk_fakentfyaccesstoken0123456789";
const OUT = "trent-alerts-7f3a9c";
const IN = "trent-replies-7f3a9c";

interface NtfyEvent { id: string; time: number; event: string; topic: string; message?: string; title?: string; tags?: string[]; attachment?: Record<string, unknown> }

/** An ntfy server: publishes land in `published`; `/<topic>/json` streams the cache after `since`, then live events. */
class FakeNtfy {
  readonly http = new FakeServer();
  readonly cache: NtfyEvent[] = [];
  private streams: http.ServerResponse[] = [];
  private seq = 0;

  async start(): Promise<void> {
    this.http
      .on("GET", "/v1/health", (_r, res) => json(res, 200, { healthy: true }))
      .on("POST", "/", (req, res) => {
        const body = req.json as { topic: string; message: string };
        json(res, 200, { id: `pub${++this.seq}`, time: 1_700_000_000, expires: 1_700_043_200, event: "message", topic: body.topic, message: body.message });
      })
      .on("GET", `/${IN}/json`, (req, res) => {
        const since = new URL(req.path, "http://ntfy").searchParams.get("since");
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        res.write(JSON.stringify({ id: "open1", time: 1_700_000_000, event: "open", topic: IN }) + "\n");
        const from = since === null ? this.cache.length : since === "all" ? 0 : this.cache.findIndex((e) => e.id === since) + 1;
        for (const e of this.cache.slice(from)) res.write(JSON.stringify(e) + "\n");
        this.streams.push(res);
      });
    await this.http.start();
  }

  get subscribers(): number {
    return this.streams.filter((s) => !s.writableEnded && !s.destroyed).length;
  }

  /** A message published to the reply topic, by the phone or anyone else who knows it. */
  reply(id: string, message: string, extra: Partial<NtfyEvent> = {}): void {
    const e: NtfyEvent = { id, time: 1_700_000_100, event: "message", topic: IN, message, ...extra };
    this.cache.push(e);
    this.live(e);
  }

  live(e: object): void {
    for (const s of this.streams) if (!s.writableEnded && !s.destroyed) s.write(JSON.stringify(e) + "\n");
  }

  published(): Array<Record<string, unknown>> {
    return this.http.find("POST", "/").filter((r) => r.path === "/").map((r) => r.json as Record<string, unknown>);
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.destroy();
    await this.http.stop();
  }
}

describe("NtfyAdapter against a local ntfy server", () => {
  let ntfy: FakeNtfy;
  let store: MemoryGatewayStore;
  const adapters: NtfyAdapter[] = [];

  const make = (settings: Record<string, string> = {}) => {
    const a = new NtfyAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store,
      baseUrls: { ntfy: ntfy.http.baseUrl },
      settings: { NTFY_TOPIC: OUT, NTFY_REPLY_TOPIC: IN, NTFY_TOKEN: TOKEN, ...settings },
    });
    adapters.push(a);
    return a;
  };

  beforeEach(async () => {
    ntfy = new FakeNtfy();
    store = new MemoryGatewayStore();
    await ntfy.start();
  });

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.stop();
    await ntfy.stop();
  });

  it("publishes JSON to the root URL with the access token, tagged as its own, with http action buttons that publish to the reply topic", async () => {
    const adapter = make();
    expect(adapter.isConfigured()).toBe(true);
    const receipt = await adapter.send({ channelId: OUT, text: "Deploy?", metadata: { subject: "Approval" }, buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }, { id: "trent:deny:appr_1:abcdef12", label: "Deny" }]] });
    expect(receipt).toEqual({ platform: "ntfy", messageId: "pub1" });
    const [req] = ntfy.http.find("POST", "/");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.json).toEqual({
      topic: OUT, message: "Deploy?", title: "Approval", tags: ["robot"],
      actions: [
        { action: "http", label: "Approve", url: `${ntfy.http.baseUrl}/${IN}`, method: "POST", body: "trent:approve:appr_1:abcdef12", clear: true },
        { action: "http", label: "Deny", url: `${ntfy.http.baseUrl}/${IN}`, method: "POST", body: "trent:deny:appr_1:abcdef12", clear: true },
      ],
    });
    // The token never rides inside a notification: the action carries no headers.
    expect(JSON.stringify(req.json)).not.toContain(TOKEN);

    const four = [["a", "b", "c", "d"].map((x) => ({ id: `trent:approve:appr_${x}:abcdef12`, label: x }))];
    await adapter.send({ channelId: OUT, text: "Too many", buttons: four });
    const second = ntfy.published()[1];
    expect(second.actions).toBeUndefined();
    expect(second.message).toContain("[d] trent:approve:appr_d:abcdef12");
  });

  it("streams the reply topic, skips its own and non-message events, and persists the last id so a restart resumes with since", async () => {
    const first: InboundMessage[] = [];
    const a = make();
    a.onMessage(async (m) => { first.push(m); });
    await a.start();
    await waitFor(() => ntfy.subscribers === 1);
    const sub = ntfy.http.find("GET", `/${IN}/json`)[0];
    expect(sub.path).toBe(`/${IN}/json`);
    expect(sub.headers.authorization).toBe(`Bearer ${TOKEN}`);
    ntfy.live({ id: "ka1", time: 1_700_000_050, event: "keepalive", topic: IN });
    ntfy.reply("own1", "Trent said this", { tags: ["robot"] });
    ntfy.reply("m1", "hello trent", { title: "from my phone" });
    await waitFor(() => first.length === 1);
    expect(first[0]).toEqual(expect.objectContaining({
      id: "m1", platform: "ntfy", channelId: OUT, senderId: IN, content: "hello trent", scope: "dm", timestamp: new Date(1_700_000_100 * 1000).toISOString(),
    }));
    await a.stop();
    expect(store.snapshot().cursors["ntfy.since"]).toBe("m1");

    ntfy.reply("m2", "while you were out");
    const second: InboundMessage[] = [];
    const b = make();
    b.onMessage(async (m) => { second.push(m); });
    await b.start();
    await waitFor(() => second.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(ntfy.http.find("GET", `/${IN}/json`)[1].path).toBe(`/${IN}/json?since=m1`);
    expect(second.map((m) => m.id)).toEqual(["m2"]);
    const health = await b.health();
    expect(health.state).toBe("up");
  });

  it("listens on the publish topic itself when no reply topic is set, and sends no Authorization header without a token", async () => {
    ntfy.http.on("GET", `/${OUT}/json`, (_req, res) => { res.writeHead(200, { "content-type": "application/x-ndjson" }); res.write(JSON.stringify({ id: "x1", time: 1, event: "message", topic: OUT, message: "same topic" }) + "\n"); });
    const inbound: InboundMessage[] = [];
    const adapter = make({ NTFY_REPLY_TOPIC: "", NTFY_TOKEN: "" });
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ channelId: OUT, senderId: OUT, content: "same topic" }));
    expect(ntfy.http.find("GET", `/${OUT}/json`)[0].headers.authorization).toBeUndefined();
    await adapter.send({ channelId: OUT, text: "no token" });
    expect(ntfy.http.find("POST", "/")[0].headers.authorization).toBeUndefined();
  });

  it("carries an audio attachment lazily from the ntfy server, and refuses one hosted anywhere else", async () => {
    const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 9]);
    ntfy.http.on("GET", "/file/voiceAbC.ogg", (_r, res) => { res.writeHead(200, { "content-type": "audio/ogg" }); res.end(Buffer.from(OGG)); });
    const inbound: InboundMessage[] = [];
    const adapter = make();
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => ntfy.subscribers === 1);
    ntfy.reply("v1", "You received a file: note.ogg", { attachment: { name: "note.ogg", url: `${ntfy.http.baseUrl}/file/voiceAbC.ogg`, type: "audio/ogg", size: OGG.length } });
    ntfy.reply("v2", "You received a file: evil.ogg", { attachment: { name: "evil.ogg", url: "https://attacker.example.test/evil.ogg", type: "audio/ogg", size: 4 } });
    await waitFor(() => inbound.length === 2);
    expect(inbound[0].attachments).toEqual([expect.objectContaining({ kind: "audio", mime: "audio/ogg", sizeBytes: OGG.length })]);
    expect(ntfy.http.find("GET", "/file/")).toEqual([]);
    const res = await inbound[0].attachments![0].open!();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(OGG);
    expect(ntfy.http.find("GET", "/file/voiceAbC.ogg")[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    await expect(inbound[1].attachments![0].open!()).rejects.toThrow(/attacker\.example\.test/);
  });
});

describe("ntfy through the GatewayManager: the reply topic is the sender", () => {
  let ntfy: FakeNtfy;
  let tempDir: string;
  let manager: GatewayManager | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-ntfy-mgr-"));
    ntfy = new FakeNtfy();
    await ntfy.start();
  });

  afterEach(async () => {
    await manager?.stopAll();
    manager = undefined;
    await ntfy.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function make(handler?: (agentId: string, m: InboundMessage) => Promise<string | null>): Promise<GatewayManager> {
    const m = new GatewayManager(new ConfigManager({ baseDir: tempDir }), {
      store: new MemoryGatewayStore(),
      agentHandler: handler,
      adapterContext: { baseUrls: { ntfy: ntfy.http.baseUrl }, settings: { NTFY_TOPIC: OUT, NTFY_REPLY_TOPIC: IN, NTFY_TOKEN: TOKEN } },
      drainIntervalMs: 20,
    });
    manager = m;
    await m.getAdapter("ntfy")!.start();
    await waitFor(() => ntfy.subscribers === 1);
    return m;
  }

  it("an unpaired reply topic gets a pairing code on the publish topic and no run; once paired, its message is routed and answered", async () => {
    const seen: Array<{ agentId: string; content: string }> = [];
    const m = await make(async (agentId, msg) => { seen.push({ agentId, content: msg.content }); return `answer from ${agentId}`; });
    m.setRoute("ntfy", "support-responder");
    ntfy.reply("h1", "hello");
    await waitFor(() => ntfy.published().length === 1);
    const offer = ntfy.published()[0] as { topic: string; message: string };
    expect(offer.topic).toBe(OUT);
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(offer.message)?.[1];
    expect(code).toBeDefined();
    expect(offer.message).not.toContain("trent "); // [C7] the stranger is shown no command; the owner pairs from `gateway pairings`
    expect(seen).toEqual([]);

    m.getPairing().pair("ntfy", code!, "regular");
    ntfy.reply("h2", "what is on today");
    await waitFor(() => ntfy.published().length === 2);
    expect(seen).toEqual([{ agentId: "support-responder", content: "what is on today" }]);
    expect(ntfy.published()[1]).toEqual(expect.objectContaining({ topic: OUT, message: "answer from support-responder", tags: ["robot"] }));
  });

  it("delivers an approval card with tap-to-approve actions; the tap publishes the action id to the reply topic and decides it", async () => {
    const m = await make();
    const bridge = m.getApprovalBridge();
    m.getPairing().grant({ platform: "ntfy", senderId: IN, scope: "dm", tier: "admin" });
    const req = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    expect((await m.sendApproval(req, "ntfy", OUT)).sent).toBe(true);
    const card = ntfy.published()[0] as { actions: Array<{ url: string; body: string }> };
    expect(card.actions.map((a) => a.body)).toEqual([`trent:approve:${req.id}:${req.nonce}`, `trent:deny:${req.id}:${req.nonce}`]);
    // The phone's tap is an HTTP POST of that body to the reply topic; the stream carries it back.
    ntfy.reply("tap1", card.actions[0].body);
    await waitFor(() => bridge.getApproval(req.id)?.status === "approved");
    expect(bridge.getApproval(req.id)?.decidedBy).toBe(`ntfy:${IN}`);
    await waitFor(() => ntfy.published().length === 2);
    expect(ntfy.published()[1]).toEqual(expect.objectContaining({ topic: OUT, message: `Approved: Deploy to production (${req.id})` }));
  });
});
