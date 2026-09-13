import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { TeamsAdapter, GRAPH_VERSION } from "./teams.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeServer, json, waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SECRET = "client-secret-value-xyz";
const CHAT = "19:abc123@thread.v2";

describe("TeamsAdapter against local Microsoft identity + Graph servers", () => {
  let server: FakeServer;
  let adapter: TeamsAdapter;

  beforeEach(async () => {
    server = new FakeServer();
    server
      .on("POST", `/${TENANT}/oauth2/v2.0/token`, (req, res) => {
        const form = new URLSearchParams(req.body);
        expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
        expect(form.get("grant_type")).toBe("client_credentials");
        expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
        expect(form.get("client_id")).toBe(CLIENT);
        expect(form.get("client_secret")).toBe(SECRET);
        json(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: "eyJ0eXAiOiJKV1Qi.access.token" });
      })
      .on("POST", `/${GRAPH_VERSION}/chats/${encodeURIComponent(CHAT)}/messages`, (_r, res) => json(res, 201, { id: "1700000000000", createdDateTime: "2023-11-14T22:13:20Z" }))
      .on("GET", `/${GRAPH_VERSION}/chats/${encodeURIComponent(CHAT)}/messages`, (_r, res) => json(res, 200, { value: [
        { id: "1700000002000", createdDateTime: "2023-11-14T22:13:22Z", from: { user: { id: "U1", displayName: "Ada" } }, body: { contentType: "html", content: "<p>hi <b>trent</b></p>" }, chatId: CHAT },
        { id: "1700000001000", createdDateTime: "2023-11-14T22:13:21Z", from: { application: { id: "APP" } }, body: { contentType: "text", content: "bot noise" }, chatId: CHAT },
      ] }));
    await server.start();
    adapter = new TeamsAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
      baseUrls: { teams: server.baseUrl, teamsLogin: server.baseUrl },
      settings: { TEAMS_TENANT_ID: TENANT, TEAMS_CLIENT_ID: CLIENT, TEAMS_CLIENT_SECRET: SECRET, TEAMS_CHAT_IDS: CHAT, TEAMS_POLL_INTERVAL_MS: "50", TEAMS_WEBHOOK_CLIENT_STATE: "cs-1" },
    });
  });

  afterEach(async () => {
    await adapter.stop();
    await server.stop();
  });

  it("acquires a client-credentials token once and posts an HTML chat message", async () => {
    const r = await adapter.send({ channelId: `chat:${CHAT}`, text: "Deploy?\nline 2 <x>", buttons: [[{ id: "trent:approve:appr_1:abcdef12", label: "Approve" }]] });
    expect(r).toEqual({ platform: "teams", messageId: "1700000000000" });
    await adapter.send({ channelId: `chat:${CHAT}`, text: "again" });
    expect(server.find("POST", `/${TENANT}/oauth2/v2.0/token`)).toHaveLength(1); // cached
    const [post] = server.find("POST", `/${GRAPH_VERSION}/chats/`);
    expect(post.headers.authorization).toBe("Bearer eyJ0eXAiOiJKV1Qi.access.token");
    expect(post.json).toEqual({ body: { contentType: "html", content: "Deploy?<br>line 2 &lt;x&gt;<br><br>[Approve] trent:approve:appr_1:abcdef12" } });
  });

  it("polls chat messages, skips application senders, strips HTML, and advances the cursor", async () => {
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({ id: "1700000002000", platform: "teams", channelId: `chat:${CHAT}`, senderId: "U1", senderName: "Ada", content: "hi trent", scope: "group", timestamp: "2023-11-14T22:13:22.000Z" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(inbound).toHaveLength(1);
    const get = server.find("GET", `/${GRAPH_VERSION}/chats/`)[0];
    expect(get.path).toContain("$top=50");
    expect((await adapter.health()).state).toBe("up");
  });

  it("answers Graph change-notification validation and checks clientState", async () => {
    const v = await adapter.handleWebhook({ method: "POST", url: "/webhooks/teams?validationToken=abc%20123", headers: {}, body: "" });
    expect(v).toEqual({ status: 200, body: "abc 123", headers: { "content-type": "text/plain" } });
    const bad = await adapter.handleWebhook({ method: "POST", url: "/webhooks/teams", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: [{ clientState: "wrong", resource: `chats/${CHAT}/messages/1` }] }) });
    expect(bad.status).toBe(202); // Graph expects 202 regardless, but nothing is processed
    expect(server.find("GET", `/${GRAPH_VERSION}/chats/`)).toHaveLength(0);
  });
});
