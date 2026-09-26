/**
 * [S2] After a late decision the gateway resumes the run and posts its reply to the thread it came
 * from. A solo run's stream ends at its gate (the handler's turn is over, the owner got a card); the
 * owner's decision lands later, on no stream, so the runner announces it and the manager drives
 * `resume` through its `RunResumer`, on the thread's own lane of the conversation queue, and sends
 * what the resumed run answered. A run that did not come from this gateway's threads is left alone.
 * The resumer is a fake; the Telegram wire is the real adapter against a local fake Bot API.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import { GatewayManager, type RunResumer } from "./GatewayManager.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";
import { FakeServer, json, waitFor } from "./testing/fakeServer.js";

const TOKEN = "777:telegram-token-for-resume-test";

interface FakeResumer extends RunResumer {
  late(runId: string): void;
  resumed: string[];
  sweeps: number;
}

function fakeResumer(threads: Record<string, { platform: string; channelId: string; threadId?: string; subject?: string }>, replies: Record<string, string | null>): FakeResumer {
  const listeners = new Set<(runId: string) => void>();
  const resumer: FakeResumer = {
    resumed: [],
    sweeps: 0,
    threadOf: (runId) => threads[runId],
    async resume(runId) {
      resumer.resumed.push(runId);
      return replies[runId] ?? null;
    },
    onLateDecision(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    sweep() {
      resumer.sweeps += 1;
    },
    late: (runId) => {
      for (const listener of listeners) listener(runId);
    },
  };
  return resumer;
}

describe("[S2] GatewayManager.resumeRun", () => {
  let dir: string;
  let server: FakeServer;
  let manager: GatewayManager | undefined;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-resume-"));
    server = new FakeServer();
    server
      .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "T", username: "trent_bot" } }))
      .on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: [] }))
      .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: 600 } }));
    await server.start();
  });
  afterEach(async () => {
    await manager?.stopAll();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(resumer: RunResumer): GatewayManager {
    manager = new GatewayManager(new ConfigManager({ baseDir: dir }), {
      store: new MemoryGatewayStore(),
      resumer,
      adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
      drainIntervalMs: 20,
    });
    return manager;
  }

  const sent = () => server.find("POST", `/bot${TOKEN}/sendMessage`).map((request) => request.json as { chat_id: string | number; text: string });

  it("a late decision resumes the run and its reply goes to the thread it came from", async () => {
    const resumer = fakeResumer({ solo_1: { platform: "telegram", channelId: "555" } }, { solo_1: "Posted the announcement." });
    make(resumer);
    resumer.late("solo_1");
    await waitFor(() => sent().length === 1);
    expect(resumer.resumed).toEqual(["solo_1"]);
    expect(sent()[0]).toMatchObject({ chat_id: 555, text: "Posted the announcement." });
  });

  it("a run from no thread of this gateway is not resumed here, and a silent resume sends nothing", async () => {
    const resumer = fakeResumer({ solo_2: { platform: "telegram", channelId: "555" } }, { solo_2: null });
    const m = make(resumer);
    expect(await m.resumeRun("solo_404")).toBe(false);
    expect(await m.resumeRun("solo_2")).toBe(true);
    expect(resumer.resumed).toEqual(["solo_2"]);
    expect(sent()).toEqual([]);
  });

  it("sweeps for rows decided elsewhere when it starts and on every drain tick, and stops listening when it stops", async () => {
    const resumer = fakeResumer({ solo_3: { platform: "telegram", channelId: "555" } }, { solo_3: "late but here" });
    const m = make(resumer);
    await m.startAllConfigured();
    await waitFor(() => resumer.sweeps >= 3);
    await m.stopAll();
    manager = undefined;
    resumer.late("solo_3");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resumer.resumed).toEqual([]);
  });
});
