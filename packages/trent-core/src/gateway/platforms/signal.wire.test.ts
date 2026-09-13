import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { SignalAdapter } from "./signal.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

const ACCOUNT = "+15550001111";

describe("SignalAdapter against a local signal-cli JSON-RPC daemon", () => {
  let server: FakeServer;
  let adapter: SignalAdapter;
  let sse: import("node:http").ServerResponse | undefined;

  beforeEach(async () => {
    server = new FakeServer();
    server
      .on("POST", "/api/v1/rpc", (req, res) => {
        const rpc = req.json as { jsonrpc: string; method: string; params: Record<string, unknown>; id: string };
        expect(rpc.jsonrpc).toBe("2.0");
        if (rpc.method === "send") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { timestamp: 1700000000123, results: [{ recipientAddress: { number: "+15557654321" }, type: "SUCCESS" }] } });
        if (rpc.method === "version") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { version: "0.13.12" } });
        if (rpc.method === "sendTyping") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: {} });
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      })
      .on("GET", "/api/v1/events", (_r, res) => {
        sse = res;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { source: "+15557654321", sourceNumber: "+15557654321", sourceName: "Ada", timestamp: 1700000000000, dataMessage: { timestamp: 1700000000000, message: "hi trent" } }, account: ACCOUNT } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { source: "+15557654321", sourceNumber: "+15557654321", timestamp: 1700000001000, dataMessage: { timestamp: 1700000001000, message: "group hi", groupInfo: { groupId: "gid==", type: "DELIVER" } } }, account: ACCOUNT } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { source: "+15557654321", timestamp: 1, receiptMessage: { when: 1, isDelivery: true } }, account: ACCOUNT } })}\n\n`);
      });
    await server.start();
    adapter = new SignalAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { signal: server.baseUrl },
      settings: { SIGNAL_NUMBER: ACCOUNT },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    sse?.end();
    await server.stop();
  });

  it("sends via JSON-RPC `send` with the account and recipient, buttons rendered as text", async () => {
    const r = await adapter.send({ channelId: "+15557654321", text: "Deploy?", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }]] });
    expect(r).toEqual({ platform: "signal", messageId: "1700000000123" });
    const [req] = server.find("POST", "/api/v1/rpc");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.json).toEqual({ jsonrpc: "2.0", id: expect.any(String), method: "send", params: { account: ACCOUNT, recipient: ["+15557654321"], message: "Deploy?\n\n[Approve] trent:approve:appr_1:abcdef12" } });
    await adapter.send({ channelId: "group:gid==", text: "to group" });
    const [, g] = server.find("POST", "/api/v1/rpc");
    expect((g.json as { params: unknown }).params).toEqual({ account: ACCOUNT, groupId: "gid==", message: "to group" });
  });

  it("streams inbound envelopes from /api/v1/events and ignores receipts", async () => {
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 2);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "1700000000000", platform: "signal", channelId: "+15557654321", senderId: "+15557654321", senderName: "Ada", content: "hi trent", scope: "dm", timestamp: "2023-11-14T22:13:20.000Z" }));
    expect(inbound[1]).toEqual(expect.objectContaining({ channelId: "group:gid==", scope: "group", content: "group hi" }));
    const h = await adapter.health();
    expect(h.state).toBe("up");
    expect(h.detail).toContain("0.13.12");
    expect(server.find("GET", "/api/v1/events")[0].path).toBe(`/api/v1/events?account=${encodeURIComponent(ACCOUNT)}`);
  });
});
