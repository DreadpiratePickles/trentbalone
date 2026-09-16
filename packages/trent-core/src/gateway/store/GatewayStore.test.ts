/**
 * The conversation-to-session mapping the gateway store carries: a chat thread is one session,
 * and the mapping has to outlive the process that wrote it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileGatewayStore,
  MemoryGatewayStore,
  clearConversationSession,
  conversationKey,
  emptyState,
  getConversationSession,
  setConversationSession,
} from "./GatewayStore.js";

describe("GatewayStore conversations", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-store-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the empty state carries an empty conversations map", () => {
    expect(emptyState().conversations).toEqual({});
  });

  it("keys a conversation by platform, chat and thread, with root standing in for no thread", () => {
    expect(conversationKey({ platform: "slack", channelId: "C1", threadId: "171.5" })).toBe("slack:C1:171.5");
    expect(conversationKey({ platform: "telegram", channelId: "555" })).toBe("telegram:555:root");
  });

  it("set then get round-trips a session id, and an unknown key is undefined", () => {
    const store = new MemoryGatewayStore();
    expect(getConversationSession(store, "slack:C1:root")).toBeUndefined();
    setConversationSession(store, "slack:C1:root", "sess_1");
    expect(getConversationSession(store, "slack:C1:root")).toBe("sess_1");
    expect(getConversationSession(store, "slack:C1:171.5")).toBeUndefined();
  });

  it("clear forgets one key and leaves the others alone", () => {
    const store = new MemoryGatewayStore();
    setConversationSession(store, "slack:C1:root", "sess_1");
    setConversationSession(store, "slack:C1:171.5", "sess_2");
    clearConversationSession(store, "slack:C1:root");
    expect(store.snapshot().conversations).toEqual({ "slack:C1:171.5": "sess_2" });
  });

  it("the mapping survives a reload through a fresh FileGatewayStore over the same file", () => {
    const file = path.join(dir, "gateway.json");
    setConversationSession(new FileGatewayStore(file), "discord:G1:T1", "sess_2");
    expect(getConversationSession(new FileGatewayStore(file), "discord:G1:T1")).toBe("sess_2");
  });

  it("a file written before conversations existed loads with an empty map, no version bump needed", () => {
    const file = path.join(dir, "gateway.json");
    const legacy = { ...emptyState() } as Record<string, unknown>;
    delete legacy.conversations;
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(new FileGatewayStore(file).snapshot().conversations).toEqual({});
  });
});
