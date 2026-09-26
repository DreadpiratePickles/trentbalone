import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageQueue } from "./MessageQueue.js";
import { FileGatewayStore, MemoryGatewayStore } from "../store/GatewayStore.js";
import type { OutboundMessage } from "../transport/types.js";

function sender(behaviour: { failTimes?: number } = {}) {
  const sent: OutboundMessage[] = [];
  let failures = behaviour.failTimes ?? 0;
  return {
    sent,
    send: async (_platform: string, msg: OutboundMessage) => {
      if (failures > 0) { failures--; throw new Error("boom"); }
      sent.push(msg);
      return { platform: _platform, messageId: `m${sent.length}` };
    },
  };
}

describe("MessageQueue — durable, per-platform, circuit-broken", () => {
  it("hands the platform receipt to onSent for every row that was actually sent, and never for a failure", async () => {
    const store = new MemoryGatewayStore();
    const s = sender({ failTimes: 1 });
    const seen: Array<[string, string, string]> = [];
    const q = new MessageQueue(store, s.send, { onSent: (row, receipt) => { seen.push([row.id, row.message.text, receipt.messageId]); } });
    const a = q.enqueue("telegram", { channelId: "1", text: "a" });
    expect((await q.drain()).failed).toBe(1);
    expect(seen).toEqual([]);
    expect((await q.drain()).sent).toBe(1);
    expect(seen).toEqual([[a.id, "a", "m1"]]);
  });

  it("enqueues durably and drains in order", async () => {
    const store = new MemoryGatewayStore();
    const s = sender();
    const q = new MessageQueue(store, s.send);
    q.enqueue("telegram", { channelId: "1", text: "a" });
    q.enqueue("telegram", { channelId: "1", text: "b" });
    expect(q.pending("telegram")).toHaveLength(2);
    const result = await q.drain();
    expect(result.sent).toBe(2);
    expect(s.sent.map((m) => m.text)).toEqual(["a", "b"]);
    expect(q.pending("telegram")).toHaveLength(0);
  });

  it("does not lose a message if the process restarts between enqueue and send", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gw-queue-"));
    const file = path.join(dir, "gateway.json");
    try {
      const first = new MessageQueue(new FileGatewayStore(file), async () => { throw new Error("adapter not up yet"); });
      first.enqueue("slack", { channelId: "C1", text: "survive me" });
      // Process dies here. A fresh process opens the same file.
      const s = sender();
      const second = new MessageQueue(new FileGatewayStore(file), s.send);
      expect(second.pending("slack")).toHaveLength(1);
      const r = await second.drain();
      expect(r.sent).toBe(1);
      expect(s.sent[0].text).toBe("survive me");
      expect(new FileGatewayStore(file).snapshot().queue.filter((m) => m.status === "pending")).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens the breaker for a flapping platform and keeps other platforms flowing", async () => {
    let now = 0;
    const store = new MemoryGatewayStore();
    const slack = sender({ failTimes: 99 });
    const telegram = sender();
    const q = new MessageQueue(
      store,
      (p, m) => (p === "slack" ? slack.send(p, m) : telegram.send(p, m)),
      { now: () => now, breaker: { failureThreshold: 2, baseBackoffMs: 5000, maxBackoffMs: 5000 } },
    );
    q.enqueue("slack", { channelId: "C", text: "s1" });
    q.enqueue("telegram", { channelId: "T", text: "t1" });
    const r1 = await q.drain();
    expect(r1.sent).toBe(1);
    expect(r1.failed).toBe(1);
    expect(q.breakerState("slack")).toBe("closed");
    await q.drain(); // second failure trips it
    expect(q.breakerState("slack")).toBe("open");
    const r3 = await q.drain();
    expect(r3.skipped).toBe(1); // paused, not retried forever
    expect(q.pending("slack")).toHaveLength(1);
    now = 5000;
    slack.sent.length = 0;
    const r4 = await q.drain(); // half-open probe still fails -> stays open with doubled backoff
    expect(r4.failed).toBe(1);
    expect(q.breakerState("slack")).toBe("open");
  });

  // [S2] The late-approve reply was lost this way: queued while the approval card's pass awaited Telegram.
  it("[S2] a drain asked for while a pass is in flight is not dropped: the row queued meanwhile is sent before that pass settles", async () => {
    const sent: string[] = [];
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const q = new MessageQueue(new MemoryGatewayStore(), async (platform, msg) => {
      if (msg.text === "card") await held; // the platform has not answered the card yet
      sent.push(msg.text);
      return { platform, messageId: `m${sent.length}` };
    });
    q.enqueue("telegram", { channelId: "555", text: "card" });
    const first = q.drain();
    q.enqueue("telegram", { channelId: "555", text: "reply" });
    const second = q.drain();
    answer();
    await Promise.all([first, second]);
    expect(sent).toEqual(["card", "reply"]);
    expect(q.pending("telegram")).toEqual([]);
  });

  it("dead-letters a message after maxAttempts", async () => {
    const store = new MemoryGatewayStore();
    const s = sender({ failTimes: 99 });
    const q = new MessageQueue(store, s.send, { maxAttempts: 2, breaker: { failureThreshold: 100, baseBackoffMs: 1, maxBackoffMs: 1 } });
    q.enqueue("email", { channelId: "a@b", text: "x" });
    await q.drain(); await q.drain();
    expect(q.pending("email")).toHaveLength(0);
    expect(store.snapshot().queue[0].status).toBe("dead");
    expect(store.snapshot().queue[0].lastError).toBe("boom");
  });
});
