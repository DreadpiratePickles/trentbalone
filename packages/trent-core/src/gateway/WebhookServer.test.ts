/**
 * [H3] The webhook server serves configured routes beside the chat adapters, over real HTTP on
 * loopback: the route reads its own raw body, answers with its own verdict, and an unknown path
 * still falls through to the adapters' 404. The runner is a recording fake.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookEngine, type WebhookEngine } from "../webhooks/engine.js";
import { githubSigned, recordingRunner, route, secrets, tempProfile } from "../webhooks/fakes.test-helpers.js";
import { webhookHttpHandler } from "../webhooks/http.js";
import { readDeliveries } from "../webhooks/store.js";
import type { GatewayManager } from "./GatewayManager.js";
import { MAX_WEBHOOK_BODY_BYTES, WebhookServer } from "./WebhookServer.js";

const noAdapters = { getAdapter: () => undefined } as unknown as GatewayManager;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(): Promise<{ base: string; engine: WebhookEngine; runner: ReturnType<typeof recordingRunner>; profileDir: string }> {
  const profileDir = tempProfile();
  const runner = recordingRunner();
  const engine = createWebhookEngine({ routes: [route()], profileDir, runnerFor: () => runner, secret: secrets });
  const server = new WebhookServer(noAdapters, { routes: webhookHttpHandler(engine) });
  const port = await server.listen(0);
  cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }), async () => engine.idle(), () => engine.close(), () => server.close());
  return { base: `http://127.0.0.1:${String(port)}`, engine, runner, profileDir };
}

describe("WebhookServer with H3 routes", () => {
  it("a signed POST to a route is 202 with the run id, over the wire", async () => {
    const { base, runner } = await serve();
    const signed = githubSigned({ delivery: "w-1", issue: { number: 7, title: "Down" } });
    const res = await fetch(`${base}/hooks/gh-issues`, { method: "POST", headers: signed.headers, body: signed.body.toString("utf8") });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run_id?: string };
    expect(body.run_id).toMatch(/^run_h3_\d+$/);
    expect(runner.inputs).toHaveLength(1);
  });

  it("an unsigned POST is 401 over the wire and starts no run", async () => {
    const { base, runner } = await serve();
    const res = await fetch(`${base}/hooks/gh-issues`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(runner.inputs).toHaveLength(0);
  });

  it("an unknown path still falls through to the adapters' 404", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/hooks/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/pigeon`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("a body over the cap is refused as too_large and starts no run", async () => {
    const { base, runner, profileDir } = await serve();
    // The answer goes out while the sender is still streaming, so the client may see the 413 or a
    // reset socket; the store row is what proves the refusal either way.
    const res = await fetch(`${base}/hooks/gh-issues`, { method: "POST", body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 10) }).catch(() => undefined);
    if (res !== undefined) expect(res.status).toBe(413);
    for (let i = 0; i < 50 && readDeliveries(profileDir, 1).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readDeliveries(profileDir, 1)[0]).toMatchObject({ verdict: "too_large", status: 413 });
    expect(runner.inputs).toHaveLength(0);
  });
});
