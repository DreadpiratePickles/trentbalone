/**
 * [C13] The gateway shows the chat that the agent is working: while a solo turn runs, the handler sends the
 * platform's typing action every 4 seconds (Telegram lets one last 5 s), and stops the moment the turn ends or
 * fails, before the reply goes out. End to end over the REAL Telegram adapter pointed at a local fake Bot API:
 * `sendChatAction` is what arrives on the wire. The turn is a stand-in that takes 20 s; no model is called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { GatewayManager, MemoryGatewayStore, type InboundMessage } from "@trent/core/gateway/index.js";
import { FakeServer, json, waitFor } from "@trent/core/gateway/testing/fakeServer.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { createAgentHandler, TYPING_INTERVAL_MS, typingFromAdapters, type AgentRuntime } from "./agent-handler.js";

const TOKEN = "999:telegram-token-for-typing";

let dir: string;
let server: FakeServer;
let manager: GatewayManager | undefined;
let wire: Array<{ readonly method: string; readonly at: number; readonly body: Record<string, unknown> }>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-typing-"));
  wire = [];
  server = new FakeServer();
  let id = 100;
  const record = (method: string, body: unknown): void => void wire.push({ method, at: Date.now(), body: (body ?? {}) as Record<string, unknown> });
  server
    .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "T", username: "trent_bot" } }))
    .on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: [] }))
    .on("POST", `/bot${TOKEN}/sendChatAction`, (r, res) => {
      record("sendChatAction", r.json);
      json(res, 200, { ok: true, result: true });
    })
    .on("POST", `/bot${TOKEN}/sendMessage`, (r, res) => {
      record("sendMessage", r.json);
      json(res, 200, { ok: true, result: { message_id: ++id } });
    });
  await server.start();
});
afterEach(async () => {
  await manager?.stopAll();
  manager = undefined;
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (): string => new Date().toISOString();
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** A solo runtime whose one turn takes `ms`, then answers, or fails by throwing. */
function slowSoloRuntime(ms: number, ends: "answers" | "throws"): AgentRuntime {
  return {
    mode: "solo",
    run: (_objective, options) =>
      (async function* (): AsyncGenerator<OrcEvent> {
        yield { kind: "run_start", runId: "solo_t1", at: at(), run: { id: "solo_t1", objective: "plan", status: "running" } };
        await sleep(ms, options?.signal);
        if (ends === "throws") throw new Error("the provider dropped the connection");
        yield { kind: "run_done", runId: "solo_t1", at: at(), run: { id: "solo_t1", status: "completed", summary: "Here is the plan." } };
      })(),
  };
}

function gatewayOver(runtime: AgentRuntime, typingIntervalMs?: number): GatewayManager {
  const configManager = new ConfigManager({ baseDir: dir });
  const store = new MemoryGatewayStore();
  const gateway: GatewayManager = new GatewayManager(configManager, {
    store,
    agentHandler: createAgentHandler(runtime, {
      configManager,
      store,
      sessions: new SessionManager(configManager),
      typing: typingFromAdapters((platform) => gateway.getAdapter(platform)),
      ...(typingIntervalMs === undefined ? {} : { typingIntervalMs }),
    }),
    adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
  });
  gateway.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
  manager = gateway;
  return gateway;
}

const MESSAGE: InboundMessage = { id: "m1", platform: "telegram", channelId: "555", senderId: "555", content: "Plan the launch", timestamp: "t", scope: "dm" };
const typing = () => wire.filter((w) => w.method === "sendChatAction");

describe("[C13] typing while a solo turn runs on the gateway", () => {
  it("a 20 s turn: sendChatAction at least every 5 s from the message to the reply, and none after the reply", async () => {
    const gateway = gatewayOver(slowSoloRuntime(20_000, "answers"));
    const received = Date.now();
    await gateway.handleInbound(MESSAGE);
    await waitFor(() => wire.some((w) => w.method === "sendMessage"), 10_000);
    const reply = wire.find((w) => w.method === "sendMessage")!;
    expect(reply.body).toMatchObject({ chat_id: 555, text: "Here is the plan." });
    expect(TYPING_INTERVAL_MS).toBe(4_000);

    const times = [received, ...typing().filter((w) => w.at <= reply.at).map((w) => w.at), reply.at];
    expect(times.length).toBeGreaterThanOrEqual(2 + 5); // at least five actions in 20 s
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${String(i)}`).toBeLessThanOrEqual(5_000);
    for (const w of typing()) expect(w.body).toEqual({ chat_id: 555, action: "typing" });
    expect(typing().every((w) => w.at <= reply.at)).toBe(true);

    // One whole interval after the reply: still nothing.
    const after = typing().length;
    await sleep(TYPING_INTERVAL_MS + 500);
    expect(typing()).toHaveLength(after);
  }, 40_000);

  it("a turn that fails stops the typing too", async () => {
    const gateway = gatewayOver(slowSoloRuntime(300, "throws"), 50);
    await gateway.handleInbound(MESSAGE).catch(() => undefined);
    await sleep(150);
    const settled = typing().length;
    expect(settled).toBeGreaterThanOrEqual(3);
    await sleep(300);
    expect(typing()).toHaveLength(settled);
  });

  it("a typing action that fails stops the typing for that turn, is reported once, and the reply is unaffected", async () => {
    let calls = 0;
    const reasons: string[] = [];
    const configManager = new ConfigManager({ baseDir: dir });
    const handler = createAgentHandler(slowSoloRuntime(300, "answers"), {
      configManager,
      store: new MemoryGatewayStore(),
      sessions: new SessionManager(configManager),
      typing: async () => {
        calls += 1;
        throw new Error("telegram: sendChatAction failed: Too Many Requests");
      },
      typingIntervalMs: 50,
      onTypingError: (reason) => void reasons.push(reason),
    });
    expect(await handler("support", MESSAGE)).toBe("Here is the plan.");
    expect(calls).toBe(1);
    expect(reasons).toEqual([expect.stringContaining("Too Many Requests")]);
  });

  it("types only where the adapter has a typing action: by chat, and by message on WhatsApp", async () => {
    const calls: string[] = [];
    const adapters: Record<string, unknown> = {
      telegram: { capabilities: () => ({ typing: true }), sendTyping: async (id: string) => void calls.push(`telegram:${id}`) },
      whatsapp: { capabilities: () => ({ typing: true }), sendTyping: async (id: string) => void calls.push(`whatsapp:${id}`) },
      slack: { capabilities: () => ({ typing: false }) },
      silent: { capabilities: () => ({ typing: true }) },
    };
    const type = typingFromAdapters((platform) => adapters[platform]);
    for (const platform of ["telegram", "whatsapp", "slack", "silent", "missing"]) await type({ ...MESSAGE, platform, id: `msg-${platform}`, channelId: `chat-${platform}` });
    expect(calls).toEqual(["telegram:chat-telegram", "whatsapp:msg-whatsapp"]);
  });
});
