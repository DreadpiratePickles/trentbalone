/**
 * [H3] Test seams for the webhook engine: a recording runner that never reaches a provider, signed
 * fake requests for every scheme, and a route builder over the real config schema.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebhookRouteSchema, type WebhookRoute } from "../config/sections/gateway.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { WebhookDelivery, WebhookRunInput, WebhookRunner } from "./types.js";

export const SECRET = "h3-test-secret-not-a-real-one";
export const SECRET_ENV = "H3_TEST_WEBHOOK_SECRET";
export const secrets = (name: string): string | undefined => (name === SECRET_ENV ? SECRET : undefined);

export function tempProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trent-h3-webhooks-"));
}

export function route(overrides: Record<string, unknown> = {}): WebhookRoute {
  return WebhookRouteSchema.parse({
    name: "gh-issues",
    path: "/hooks/gh-issues",
    secret_env: SECRET_ENV,
    signature: "github",
    objective_template: "Triage GitHub issue #{{payload.issue.number}}: {{payload.issue.title}}",
    dedupe_key: "{{payload.delivery}}",
    ...overrides,
  });
}

export const hmacHex = (secret: string, data: string | Buffer): string => crypto.createHmac("sha256", secret).update(data).digest("hex");

export interface Signed {
  readonly body: Buffer;
  readonly headers: Record<string, string>;
}

export function githubSigned(payload: unknown, secret = SECRET): Signed {
  const body = Buffer.from(JSON.stringify(payload));
  return { body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmacHex(secret, body)}`, "x-github-event": "issues" } };
}

export function stripeSigned(payload: unknown, at: Date, secret = SECRET): Signed {
  const body = Buffer.from(JSON.stringify(payload));
  const t = Math.floor(at.getTime() / 1000);
  return { body, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${hmacHex(secret, `${t}.${body.toString("utf8")}`)}` } };
}

// [C8] hmac-sha256-ts: hex HMAC over `<unix-seconds>.<raw body>`. The timestamp rides its own header
// (default x-trent-timestamp), or with `inline` inside the signature header as `t=<unix>,v1=<hex>`.
export function timestampSigned(payload: unknown, at: Date, options: { secret?: string; inline?: boolean; signatureHeader?: string; timestampHeader?: string } = {}): Signed {
  const body = Buffer.from(JSON.stringify(payload));
  const t = String(Math.floor(at.getTime() / 1000));
  const hex = hmacHex(options.secret ?? SECRET, `${t}.${body.toString("utf8")}`);
  const signatureHeader = (options.signatureHeader ?? "x-webhook-signature").toLowerCase();
  if (options.inline === true) return { body, headers: { "content-type": "application/json", [signatureHeader]: `t=${t},v1=${hex}` } };
  return { body, headers: { "content-type": "application/json", [signatureHeader]: `sha256=${hex}`, [(options.timestampHeader ?? "x-trent-timestamp").toLowerCase()]: t } };
}

export function delivery(signed: Signed, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return { method: "POST", path: "/hooks/gh-issues", headers: signed.headers, body: signed.body, peer: "127.0.0.1", boundAddress: "127.0.0.1", ...overrides };
}

export interface RecordingRunner extends WebhookRunner {
  readonly inputs: WebhookRunInput[];
  /** Frame reads and seeds in the order they happened. */
  readonly log: string[];
}

let runCounter = 0;

/** One run per call: run_start, one metered step per entry of `costs`, then run_done. */
export function recordingRunner(options: { costs?: readonly number[]; fail?: Error; runIdPrefix?: string } = {}): RecordingRunner {
  const inputs: WebhookRunInput[] = [];
  const log: string[] = [];
  return {
    inputs,
    log,
    run(input: WebhookRunInput): AsyncIterable<OrcEvent> {
      inputs.push(input);
      if (options.fail !== undefined) throw options.fail;
      runCounter += 1;
      const runId = `${options.runIdPrefix ?? "run_h3_"}${String(runCounter)}`;
      const at = "2026-09-26T09:00:00.000Z";
      return (async function* frames(): AsyncGenerator<OrcEvent> {
        log.push("frame:run_start");
        yield { kind: "run_start", runId, at, run: { objective: input.objective } };
        let n = 0;
        for (const costCents of options.costs ?? []) {
          n += 1;
          if (input.signal.aborted) {
            log.push("frame:run_cancelled");
            yield { kind: "run_cancelled", runId, at };
            return;
          }
          log.push(`frame:step_end:${String(n)}`);
          yield { kind: "step_end", runId, at, step: { id: `s${String(n)}`, costCents, agentRole: "ceo", model: "fake" } };
        }
        if (input.signal.aborted) {
          log.push("frame:run_cancelled");
          yield { kind: "run_cancelled", runId, at };
          return;
        }
        log.push("frame:run_done");
        yield { kind: "run_done", runId, at, run: { status: "completed", summary: "handled" } };
      })();
    },
  };
}
