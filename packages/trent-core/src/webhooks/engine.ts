/**
 * [H3] The webhook engine: a signed delivery to a configured route starts ONE run through the
 * runner port of the route's mode, and is answered 202 with that run's id.
 *
 * The order is the gate. Method and size first (neither reads the body), then the signature over
 * the raw bytes (`signature.ts`), or for `none-localhost-only` a loopback peer on a loopback
 * listener; only then is the body parsed. An event the route does not list is answered 200 and
 * ignored. The dedupe key (the route's `dedupe_key` template, else the body's SHA-256) is looked up
 * before the rate limit, so a retried delivery is answered 200 with its original run id for 24 h
 * whatever the limit says, and never starts a second run; the key is reserved synchronously
 * before the runner is called, so two copies arriving together start one. A run that never
 * produced a frame releases its key, so the sender's retry can start it.
 *
 * The run's first message carries the inbound-provenance marker and its policy ring is seeded on
 * its first frame (`taint.ts`); a seed that fails stops the run. The route's `max_cost_cents` is
 * handed to the runner and also enforced here: the metered frames (`step_end`,
 * `consolidate_end` `costCents`, the ones the spend ledger charges) are summed and the run is
 * aborted when they reach the cap. Every delivery and every run's end is a row in the delivery
 * store (`store.ts`).
 */
import crypto from "node:crypto";
import { createAgentRunFold } from "../agent-runner/index.js";
import type { WebhookRoute } from "../config/sections/gateway.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { isLoopbackAddress, verifyWebhookSignature } from "./signature.js";
import { DEDUPE_WINDOW_MS, openDeliveryStore } from "./store.js";
import { webhookObjective, webhookSource } from "./taint.js";
import { renderWebhookTemplate } from "./template.js";
import { RUN_VERDICTS, type DeliveryRow, type DeliveryVerdict, type WebhookDelivery, type WebhookResponse, type WebhookRunInput, type WebhookRunnerFor } from "./types.js";

export const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_KEY_CHARS = 200;
const RATE_WINDOW_MS = 60_000;

export interface WebhookEngineDeps {
  readonly routes: readonly WebhookRoute[];
  /** The delivery store lives under `<profileDir>/webhooks/`. */
  readonly profileDir: string;
  readonly runnerFor: WebhookRunnerFor;
  /** Resolves a route's `secret_env` NAME to its value. Default: `process.env`. */
  readonly secret?: (envName: string) => string | undefined;
  /** Seeds the run's policy ring with one inbound read (`taint.ts` seedInboundTaint). */
  readonly seedInbound?: (runId: string, source: string) => void | Promise<void>;
  readonly now?: () => Date;
  /** How long a delivery waits for the run's first frame before answering 202 without a run id. */
  readonly firstFrameTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface WebhookEngine {
  match(path: string): WebhookRoute | undefined;
  deliver(delivery: WebhookDelivery): Promise<WebhookResponse>;
  /** Resolves once every run this engine started has ended. */
  idle(): Promise<void>;
  /** Aborts every run still going. */
  close(): void;
}

interface KeyEntry {
  readonly deliveryId: string;
  readonly at: number;
  runId?: string;
  /** Settles when the first delivery has been answered. */
  answered?: Promise<void>;
}

const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): WebhookResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));
const messageOf = (error: unknown): string => clip(error instanceof Error ? error.message : String(error), 200);

function eventName(route: WebhookRoute, delivery: WebhookDelivery, payload: unknown): string | undefined {
  if (route.signature === "github") return delivery.headers["x-github-event"];
  const type = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).type : undefined;
  return typeof type === "string" ? type : undefined;
}

export function createWebhookEngine(deps: WebhookEngineDeps): WebhookEngine {
  const now = deps.now ?? (() => new Date());
  const secretOf = deps.secret ?? ((name: string) => process.env[name]);
  const store = openDeliveryStore(deps.profileDir, now);
  const byPath = new Map(deps.routes.map((route) => [route.path, route]));
  const index = new Map<string, KeyEntry>();
  const starts = new Map<string, number[]>();
  const inflight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const indexKey = (route: string, key: string): string => `${route}\u0000${key}`;

  // The dedupe index across a restart: a started row opens an entry, a later row fills its run id.
  const byDelivery = new Map<string, KeyEntry>();
  for (const row of store.rows()) {
    if (row.key === undefined || !RUN_VERDICTS.includes(row.verdict)) continue;
    const known = byDelivery.get(row.delivery);
    if (known !== undefined) {
      known.runId ??= row.run_id;
      continue;
    }
    const entry: KeyEntry = { deliveryId: row.delivery, at: Date.parse(row.at), ...(row.run_id === undefined ? {} : { runId: row.run_id }) };
    byDelivery.set(row.delivery, entry);
    index.set(indexKey(row.route, row.key), entry);
  }

  const record = (route: WebhookRoute, delivery: string, verdict: DeliveryVerdict, fields: Partial<DeliveryRow> = {}): void => {
    store.append({ at: now().toISOString(), delivery, route: route.name, verdict, mode: route.mode, ...fields });
  };

  /** The signature, or the loopback rule. Undefined means the delivery is authentic. */
  function authenticate(route: WebhookRoute, d: WebhookDelivery, deliveryId: string): WebhookResponse | undefined {
    if (route.signature === "none-localhost-only") {
      if (isLoopbackAddress(d.boundAddress) && isLoopbackAddress(d.peer)) return undefined;
      record(route, deliveryId, "not_loopback", { status: 403, detail: isLoopbackAddress(d.boundAddress) ? "peer is not loopback" : "listener is not bound to loopback" });
      return reply(403, { error: "this route answers a loopback peer on a loopback listener only" });
    }
    const name = route.secret_env ?? "";
    const secret = secretOf(name);
    if (secret === undefined || secret === "") {
      record(route, deliveryId, "no_secret", { status: 503, detail: `${name} is not set` });
      return reply(503, { error: `the route's secret is not configured: set ${name}` });
    }
    const verdict = verifyWebhookSignature({ route, body: d.body, headers: d.headers, secret, now: now() });
    if (verdict.ok) return undefined;
    record(route, deliveryId, "bad_signature", { status: 401, detail: verdict.reason });
    return reply(401, { error: "signature verification failed" });
  }

  function rateLimited(route: WebhookRoute): number | undefined {
    const at = now().getTime();
    const recent = (starts.get(route.name) ?? []).filter((t) => at - t < RATE_WINDOW_MS);
    starts.set(route.name, recent);
    if (recent.length < route.rate_per_minute) {
      recent.push(at);
      return undefined;
    }
    return Math.max(1, Math.ceil((recent[0]! + RATE_WINDOW_MS - at) / 1000));
  }

  /** Reads the rest of the run, meters it against the cap, and records how it ended. */
  async function drain(route: WebhookRoute, deliveryId: string, key: string, iterator: AsyncIterator<OrcEvent>, first: OrcEvent, controller: AbortController): Promise<void> {
    const fold = createAgentRunFold();
    const cap = route.max_cost_cents;
    let spent = 0;
    let capped = false;
    const apply = (event: OrcEvent): void => {
      fold.apply(event);
      const cents = event.step?.costCents;
      if ((event.kind === "step_end" || event.kind === "consolidate_end") && typeof cents === "number" && cents > 0) spent += cents;
      if (cap !== undefined && spent >= cap && !capped) {
        capped = true;
        controller.abort(new Error(`cost cap: ${String(spent)} of ${String(cap)} cents`));
      }
    };
    let outcome = fold.outcome();
    try {
      apply(first);
      for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) apply(next.value);
      outcome = fold.outcome();
    } catch (error) {
      outcome = fold.fail(error);
    } finally {
      controllers.delete(controller);
    }
    const verdict: DeliveryVerdict = capped && outcome.status !== "completed" ? "cost_cap" : outcome.status;
    const detail = capped ? `stopped at ${String(spent)} of ${String(cap)} cents` : `spent ${String(spent)} cents`;
    record(route, deliveryId, verdict, { key, ...(outcome.runId === undefined ? {} : { run_id: outcome.runId }), detail });
  }

  async function start(route: WebhookRoute, deliveryId: string, key: string, payload: unknown): Promise<WebhookResponse> {
    const runner = deps.runnerFor(route.mode);
    if (runner === undefined) {
      record(route, deliveryId, "no_runner", { status: 503, key, detail: `no ${route.mode} runner` });
      return reply(503, { error: `this gateway has no ${route.mode} runner for route ${route.name}` });
    }
    const slot = indexKey(route.name, key);
    const entry: KeyEntry = { deliveryId, at: now().getTime() };
    let answered!: () => void;
    entry.answered = new Promise<void>((resolve) => (answered = resolve));
    index.set(slot, entry);
    const fail = (detail: string): WebhookResponse => {
      if (index.get(slot) === entry) index.delete(slot);
      answered();
      record(route, deliveryId, "run_error", { status: 502, key, detail });
      return reply(502, { error: "the run could not be started", detail });
    };
    const controller = new AbortController();
    const source = webhookSource(route.name);
    const input: WebhookRunInput = {
      objective: webhookObjective(route, renderWebhookTemplate(route.objective_template, payload)),
      signal: controller.signal,
      mode: route.mode,
      surface: "webhook",
      route: route.name,
      deliveryId,
      provenance: "untrusted",
      inbound: source,
      ...(route.seat === undefined ? {} : { seat: route.seat }),
      ...(route.max_cost_cents === undefined ? {} : { maxCostCents: route.max_cost_cents }),
    };
    let iterator: AsyncIterator<OrcEvent>;
    let first: Promise<IteratorResult<OrcEvent>>;
    try {
      iterator = runner.run(input)[Symbol.asyncIterator]();
      first = iterator.next();
    } catch (error) {
      return fail(messageOf(error));
    }
    controllers.add(controller);
    // The first frame names the run; the ring is seeded before another frame is read.
    const opened = first.then(async (result) => {
      if (result.done === true) throw new Error("the run produced no frame");
      entry.runId = result.value.runId;
      try {
        await deps.seedInbound?.(result.value.runId, source);
      } catch (error) {
        controller.abort(error);
        throw new Error(`the inbound taint could not be seeded, so the run was stopped: ${messageOf(error)}`);
      }
      return result.value;
    });
    const timeoutMs = deps.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const race = await Promise.race([
      opened.then((frame) => ({ frame }), (error: unknown) => ({ error })),
      new Promise<{ timeout: true }>((resolve) => (timer = setTimeout(() => resolve({ timeout: true }), timeoutMs))),
    ]);
    clearTimeout(timer);
    if ("error" in race) {
      controllers.delete(controller);
      void iterator.return?.().catch(() => undefined);
      deps.log?.(`webhook ${route.name}: ${messageOf(race.error)}`);
      return fail(messageOf(race.error));
    }
    const runId = "frame" in race ? race.frame.runId : undefined;
    record(route, deliveryId, "started", { status: 202, key, ...(runId === undefined ? {} : { run_id: runId }), ...(runId === undefined ? { detail: "no frame yet" } : {}) });
    answered();
    const background = opened
      .then((frame) => drain(route, deliveryId, key, iterator, frame, controller))
      .catch((error: unknown) => {
        controllers.delete(controller);
        record(route, deliveryId, "failed", { key, ...(entry.runId === undefined ? {} : { run_id: entry.runId }), detail: messageOf(error) });
      })
      .finally(() => inflight.delete(background));
    inflight.add(background);
    return reply(202, { accepted: true, route: route.name, delivery_id: deliveryId, run_id: runId ?? null });
  }

  return {
    match: (path) => byPath.get(path),

    async deliver(d) {
      const route = byPath.get(d.path);
      if (route === undefined) return reply(404, { error: "no such webhook route" });
      const deliveryId = `whd_${crypto.randomBytes(8).toString("hex")}`;
      if (d.method.toUpperCase() !== "POST") {
        record(route, deliveryId, "method", { status: 405, detail: d.method.toUpperCase() });
        return reply(405, { error: "only POST starts a run" }, { allow: "POST" });
      }
      if (d.truncated === true) {
        record(route, deliveryId, "too_large", { status: 413 });
        return reply(413, { error: "the body is over the webhook cap" });
      }
      const refused = authenticate(route, d, deliveryId);
      if (refused !== undefined) return refused;
      let payload: unknown;
      try {
        payload = JSON.parse(d.body.toString("utf8"));
      } catch {
        record(route, deliveryId, "bad_body", { status: 400, detail: "the body is not JSON" });
        return reply(400, { error: "the body is not JSON" });
      }
      const event = eventName(route, d, payload);
      if (route.events !== undefined && (event === undefined || !route.events.includes(event))) {
        record(route, deliveryId, "ignored", { status: 200, detail: `event ${clip(event ?? "(none)", 100)}` });
        return reply(200, { accepted: false, ignored: true, route: route.name });
      }
      const rendered = route.dedupe_key === undefined ? "" : renderWebhookTemplate(route.dedupe_key, payload).trim();
      const key = clip(rendered === "" ? `sha256:${crypto.createHash("sha256").update(d.body).digest("hex")}` : rendered, MAX_KEY_CHARS);
      for (;;) {
        const known = index.get(indexKey(route.name, key));
        if (known === undefined || now().getTime() - known.at >= DEDUPE_WINDOW_MS) break;
        if (known.runId === undefined && known.answered !== undefined) {
          await known.answered;
          if (index.get(indexKey(route.name, key)) !== known) continue;
        }
        record(route, deliveryId, "replay", { status: 200, key, ...(known.runId === undefined ? {} : { run_id: known.runId }), detail: `first delivery ${known.deliveryId}` });
        return reply(200, { accepted: true, replay: true, route: route.name, delivery_id: known.deliveryId, run_id: known.runId ?? null });
      }
      const retryAfter = rateLimited(route);
      if (retryAfter !== undefined) {
        record(route, deliveryId, "rate_limited", { status: 429, key, detail: `${String(route.rate_per_minute)} per minute` });
        return reply(429, { error: `route ${route.name} is over ${String(route.rate_per_minute)} runs per minute` }, { "retry-after": String(retryAfter) });
      }
      return start(route, deliveryId, key, payload);
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    close() {
      for (const controller of controllers) controller.abort(new Error("the webhook engine closed"));
    },
  };
}
