/**
 * [S2] The gateway on the solo runner, end to end over the real Telegram adapter (a local fake Bot API):
 * a chat message becomes a solo run on the session keyed by the thread; the runner is that session's
 * only writer (council A1); a held call parks the run, its frames reach the approval link, and the owner
 * gets a card; the owner's LATE approve is announced by the router and the gateway resumes the run and
 * posts its reply to the thread it came from. A message on another thread in between neither resumes
 * nor abandons the held call (A2). The model is a scripted gateway; nothing reaches a provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { GatewayManager, MemoryGatewayStore, linkRunApprovals, type RunApprovalLink } from "@trent/core/gateway/index.js";
import { FakeServer, json, waitFor } from "@trent/core/gateway/testing/fakeServer.js";
import { applyHoldPolicy } from "@trent/core/solo/hold-policy.js";
import { createSoloRouter } from "@trent/core/solo/router.js";
import { createSoloRunner } from "@trent/core/solo/runner.js";
import { profileSoloSession } from "@trent/core/solo/session-store.js";
import { FIXED_NOW, fakeAdapter, fakeMemory, fakeMeter, scriptedGateway, sequentialIds, toolCall } from "@trent/core/solo/fakes.test-helpers.js";
import type { ModeRunner } from "../runtime/runner-for-mode.js";
import { createAgentHandler, createRunResumer, createRunThreads, type AgentRuntime } from "./agent-handler.js";

const TOKEN = "888:telegram-token-for-solo-gateway";
const POST = 'social_post {"platform": "bluesky", "text": "The oak tables are in."}';

let dir: string;
let server: FakeServer;
let manager: GatewayManager | undefined;
let link: RunApprovalLink | undefined;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-gateway-"));
  server = new FakeServer();
  let id = 700;
  server
    .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "T", username: "trent_bot" } }))
    .on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: [] }))
    .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: ++id } }))
    .on("POST", `/bot${TOKEN}/answerCallbackQuery`, (_r, res) => json(res, 200, { ok: true, result: true }));
  await server.start();
});
afterEach(async () => {
  link?.close();
  await manager?.stopAll();
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A solo runtime as the gateway sees it: the router behind the runner port, its frames on the approval link. */
/** `scripts` are handed to the conversations in the order they first run: one scripted model per thread. */
function soloRuntime(configManager: ConfigManager, sessions: SessionManager, scripts: string[][]) {
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const ids = sequentialIds();
  const router = createSoloRouter({
    holds: "park",
    sinks: [{ sink: (event) => link?.sink(event) }],
    create: (conversation) =>
      createSoloRunner({
        gateway: scriptedGateway(scripts.shift() ?? []),
        tools: { adapters: applyHoldPolicy([social], conversation.holds) },
        session: profileSoloSession(sessions, conversation.sessionId ?? ""),
        memory: fakeMemory().memory,
        meter: fakeMeter(),
        now: FIXED_NOW,
        newId: ids,
      }),
  });
  const runner: ModeRunner = {
    mode: "solo",
    label: "solo · gemini-test",
    run: (input) => router.run(input),
    approve: router.approve,
    reject: router.reject,
    answer: router.answer,
    resume: router.resume,
    onLateDecision: router.onLateDecision,
    conversationOf: router.conversationOf,
    parked: router.parked,
    sweep: router.sweep,
  };
  const runtime: AgentRuntime = { mode: "solo", runner, run: (objective, options = {}) => runner.run({ objective, ...options }) };
  return { runtime, social, configManager };
}

const sent = () => server.find("POST", `/bot${TOKEN}/sendMessage`).map((request) => request.json as { chat_id: number; text: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } });

// [S2] One gateway over the solo runtime, never started: no drain tick, so every reply rides on its own send.
function soloGateway(scripts: string[][]) {
  const configManager = new ConfigManager({ baseDir: dir });
  const sessions = new SessionManager(configManager);
  const store = new MemoryGatewayStore();
  const { runtime, social } = soloRuntime(configManager, sessions, scripts);
  const threads = createRunThreads();
  const gateway = new GatewayManager(configManager, {
    store,
    agentHandler: createAgentHandler(runtime, { configManager, store, sessions, threads }),
    resumer: createRunResumer(runtime, threads, { store }),
    adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
  });
  manager = gateway;
  link = linkRunApprovals({ orchestrator: runtime.runner as ModeRunner, bridge: gateway.getApprovalBridge(), manager: gateway, owner: { platform: "telegram", channelId: "555" }, log: () => undefined });
  gateway.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
  gateway.getPairing().grant({ platform: "telegram", senderId: "777", scope: "dm", tier: "regular" });
  return { manager: gateway, runtime, social, sessions };
}

describe("[S2] the gateway on the solo runner", () => {
  it("a held call parks, the owner's late approve resumes the SAME run, and the reply goes to the thread", async () => {
    const { manager, runtime, social, sessions } = soloGateway([[toolCall(POST), "Posted: the oak tables are in."], ["Hello from thread 777."]]); // [S2]

    await manager.handleInbound({ id: "m1", platform: "telegram", channelId: "555", senderId: "555", content: "Announce the tables", timestamp: "t", scope: "dm" });
    await waitFor(() => sent().length === 1);
    const card = sent()[0]!;
    const approve = card.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect(approve).toMatch(/^trent:approve:/);
    expect(social.calls).toEqual([]);
    const [parked] = (runtime.runner as ModeRunner).parked?.() ?? [];
    expect(parked).toBeDefined();

    // Another thread in between: its own session and runner; the held call on 555 is untouched.
    await manager.handleInbound({ id: "m2", platform: "telegram", channelId: "777", senderId: "777", content: "hello there", timestamp: "t", scope: "dm" });
    expect((runtime.runner as ModeRunner).parked?.()).toEqual([expect.objectContaining({ runId: parked!.runId })]);

    const ack = await manager.handleCallback({ platform: "telegram", callbackId: "c1", senderId: "555", channelId: "555", scope: "dm", actionId: approve });
    expect(ack.ok).toBe(true);
    await waitFor(() => sent().some((message) => message.text === "Posted: the oak tables are in."));
    const reply = sent().find((message) => message.text === "Posted: the oak tables are in.");
    expect(reply?.chat_id).toBe(555);
    expect(social.calls.map((call) => call.action)).toEqual([POST]);
    expect((runtime.runner as ModeRunner).parked?.()).toEqual([]);

    // A1: the handler wrote nothing itself; the thread's session is the runner's transcript alone.
    const session555 = sessions.listSessions().find((s) => s.messages[0]?.content === "Announce the tables");
    expect(session555?.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Announce the tables"]);
    expect(session555?.messages.at(-1)).toMatchObject({ role: "assistant", content: "Posted: the oak tables are in." });
  });

  // [S2] Red 12: the interleaving that lost the reply, pinned. Telegram has not answered the card yet (its drain pass is
  // in flight) when the resumed run's reply is queued; that reply must still reach the thread, with no drain tick.
  it("the reply to a late approve reaches the thread even when it is queued while the card is still being delivered", async () => {
    let answerCard!: () => void;
    const cardAnswered = new Promise<void>((resolve) => { answerCard = resolve; });
    let id = 900;
    server.on("POST", `/bot${TOKEN}/sendMessage`, async (request, res) => {
      if ((request.json as { reply_markup?: unknown }).reply_markup !== undefined) await cardAnswered;
      json(res, 200, { ok: true, result: { message_id: ++id } });
    });
    const { manager, runtime, social } = soloGateway([[toolCall(POST), "Posted: the oak tables are in."]]);

    await manager.handleInbound({ id: "m1", platform: "telegram", channelId: "555", senderId: "555", content: "Announce the tables", timestamp: "t", scope: "dm" });
    await waitFor(() => sent().length === 1);
    const approve = sent()[0]!.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect((await manager.handleCallback({ platform: "telegram", callbackId: "c1", senderId: "555", channelId: "555", scope: "dm", actionId: approve })).ok).toBe(true);
    // The run resumed and its reply is queued while the card's pass still waits on Telegram.
    await waitFor(() => manager.getQueue().pending("telegram").some((row) => row.message.text === "Posted: the oak tables are in."));
    expect(social.calls.map((call) => call.action)).toEqual([POST]);
    expect((runtime.runner as ModeRunner).parked?.()).toEqual([]);
    expect(sent()).toHaveLength(1);

    answerCard();
    await waitFor(() => sent().some((message) => message.text === "Posted: the oak tables are in."));
    expect(sent().map((message) => message.text.startsWith("APPROVAL") ? "card" : message.text)).toEqual(["card", "Posted: the oak tables are in."]);
    // The server records a request before its answer reaches the queue, which marks the row sent on that answer.
    await waitFor(() => manager.getQueue().pending("telegram").length === 0);
  });
});
