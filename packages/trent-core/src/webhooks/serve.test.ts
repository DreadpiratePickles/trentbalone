/**
 * [H3] `openWebhookRoutes` (the surface's one call) and the status lines `trent gateway status`
 * shows, over real HTTP on loopback with a recording runner.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WebhooksConfigSchema } from "../config/sections/gateway.js";
import type { GatewayManager } from "../gateway/GatewayManager.js";
import { githubSigned, recordingRunner, secrets, SECRET_ENV, tempProfile } from "./fakes.test-helpers.js";
import { openWebhookRoutes } from "./serve.js";
import { webhookStatus, webhookStatusLines } from "./status.js";

const noAdapters = { getAdapter: () => undefined } as unknown as GatewayManager;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const block = WebhooksConfigSchema.parse({
  port: 0,
  routes: [{ name: "gh-issues", path: "/hooks/gh-issues", secret_env: SECRET_ENV, signature: "github", objective_template: "Triage #{{payload.issue.number}}", dedupe_key: "{{payload.delivery}}" }],
});

describe("openWebhookRoutes", () => {
  it("builds nothing and listens nowhere without routes", async () => {
    const profileDir = tempProfile();
    dirs.push(profileDir);
    expect(await openWebhookRoutes({ block: undefined, profileDir, manager: noAdapters, runnerFor: () => undefined })).toBeUndefined();
    expect(await openWebhookRoutes({ block: WebhooksConfigSchema.parse({}), profileDir, manager: noAdapters, runnerFor: () => undefined })).toBeUndefined();
    expect(fs.existsSync(`${profileDir}/webhooks`)).toBe(false);
  });

  it("serves the configured routes on loopback and starts a run through the runner port", async () => {
    const profileDir = tempProfile();
    dirs.push(profileDir);
    const runner = recordingRunner();
    const opened = await openWebhookRoutes({ block, profileDir, manager: noAdapters, runnerFor: (mode) => (mode === "fleet" ? runner : undefined), secret: secrets });
    try {
      expect(opened).toMatchObject({ host: "127.0.0.1", routes: ["gh-issues"] });
      const signed = githubSigned({ delivery: "s-1", issue: { number: 9 } });
      const res = await fetch(`http://127.0.0.1:${String(opened!.port)}/hooks/gh-issues`, { method: "POST", headers: signed.headers, body: signed.body.toString("utf8") });
      expect(res.status).toBe(202);
    } finally {
      await opened?.close();
    }
    expect(runner.inputs[0]?.objective).toContain("Triage #9");
    const lines = webhookStatusLines(webhookStatus(profileDir, block));
    expect(lines[0]).toBe("1 webhook route(s), served on 127.0.0.1:0 while the gateway runs");
    expect(lines.some((line) => /gh-issues started 202 run_h3_\d+ key s-1$/.test(line))).toBe(true);
    expect(lines.some((line) => /gh-issues completed run_h3_\d+ key s-1$/.test(line))).toBe(true);
  });

  it("says plainly when no route is configured", () => {
    const profileDir = tempProfile();
    dirs.push(profileDir);
    expect(webhookStatusLines(webhookStatus(profileDir, undefined))).toEqual(["no webhook routes configured (gateway.webhooks.routes)"]);
  });
});
