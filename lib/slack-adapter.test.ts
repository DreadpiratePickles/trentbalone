import { describe, expect, it, vi } from "vitest";
import { createSlackAdapter } from "./slack-adapter";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const ENV = { SLACK_BOT_TOKEN: "xoxb-test-123", SLACK_DEFAULT_CHANNEL: "#ops" };

describe("Slack adapter", () => {
  it("fails closed without a bot token", async () => {
    const fetchImpl = vi.fn();
    const adapter = createSlackAdapter({ env: {}, fetchImpl });
    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute("post", { text: "hi" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("SLACK_BOT_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports connected when auth.test passes and never gates posting", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, team: "Acme" }));
    const adapter = createSlackAdapter({ env: ENV, fetchImpl });
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(adapter.requiresApproval("post")).toBe(false);
    expect(adapter.estimateCost()).toBe(0);
  });

  it("posts a message to the default channel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1700000000.0001" }));
    const adapter = createSlackAdapter({ env: ENV, fetchImpl });

    const result = await adapter.execute("notify", { text: "Weekly founder brief is ready." });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("#ops");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ channel: "#ops", text: "Weekly founder brief is ready." });
  });

  it("requires a channel and a text body", async () => {
    const fetchImpl = vi.fn();
    const noChannel = createSlackAdapter({ env: { SLACK_BOT_TOKEN: "xoxb-x" }, fetchImpl });
    const r1 = await noChannel.execute("post", { text: "hi" });
    expect(r1.status).toBe("failed");
    expect(r1.summary).toContain("channel");

    const r2 = await createSlackAdapter({ env: ENV, fetchImpl }).execute("post", {});
    expect(r2.status).toBe("failed");
    expect(r2.summary).toContain("payload.text");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces Slack API errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "channel_not_found" }));
    const adapter = createSlackAdapter({ env: ENV, fetchImpl });
    const result = await adapter.execute("post", { text: "hi", channel: "#nope" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("channel_not_found");
  });
});
