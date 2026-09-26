/**
 * [H3] The webhook engine end to end with fake requests and a recording runner: nothing here
 * reaches a model provider. Each `it` is one line of the H3 brief (docs/sessions/2026-09-26-h3-webhooks.md).
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyDispatcher } from "../governance/policy-dispatch.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import { createWebhookEngine, type WebhookEngine, type WebhookEngineDeps } from "./engine.js";
import { delivery, githubSigned, hmacHex, recordingRunner, route, SECRET, SECRET_ENV, secrets, stripeSigned, tempProfile, timestampSigned, type RecordingRunner } from "./fakes.test-helpers.js"; // [C8] timestampSigned
import { readDeliveries } from "./store.js";
import { classifyCall } from "../governance/policy-rules.js";
import { INBOUND_SEED_CALL, seedInboundTaint } from "./taint.js";
import type { WebhookRoute } from "../config/sections/gateway.js";

const T0 = new Date("2026-09-26T09:00:00.000Z");
const dirs: string[] = [];
const engines: WebhookEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.idle();
    engine.close();
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Built {
  engine: WebhookEngine;
  runner: RecordingRunner;
  profileDir: string;
  clock: { now: Date };
}

function build(routes: WebhookRoute[] = [route()], overrides: Partial<WebhookEngineDeps> & { runner?: RecordingRunner; profileDir?: string } = {}): Built {
  const profileDir = overrides.profileDir ?? tempProfile();
  if (overrides.profileDir === undefined) dirs.push(profileDir);
  const runner = overrides.runner ?? recordingRunner();
  const clock = { now: T0 };
  const engine = createWebhookEngine({ routes, profileDir, runnerFor: () => runner, secret: secrets, now: () => clock.now, ...overrides });
  engines.push(engine);
  return { engine, runner, profileDir, clock };
}

const issue = (id: string, title = "Checkout is down") => ({ delivery: id, action: "opened", issue: { number: 42, title } });
const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

describe("H3 webhook routes: signature first", () => {
  it("a good signature starts one run and answers 202 with its run id", async () => {
    const { engine, runner } = build();
    const out = await engine.deliver(delivery(githubSigned(issue("d-1"))));
    expect(out.status).toBe(202);
    expect(runner.inputs).toHaveLength(1);
    expect(json(out.body)).toMatchObject({ accepted: true, route: "gh-issues" });
    expect(String(json(out.body).run_id)).toMatch(/^run_h3_\d+$/);
  });

  it("a bad signature is 401 and starts no run", async () => {
    const { engine, runner } = build();
    const out = await engine.deliver(delivery(githubSigned(issue("d-2"), "the-wrong-secret")));
    expect(out.status).toBe(401);
    expect(runner.inputs).toHaveLength(0);
  });

  it("an unsigned request to a signed route is 401 and starts no run", async () => {
    const { engine, runner } = build();
    const signed = githubSigned(issue("d-3"));
    const out = await engine.deliver(delivery({ body: signed.body, headers: { "content-type": "application/json" } }));
    expect(out.status).toBe(401);
    expect(runner.inputs).toHaveLength(0);
  });

  it("a route whose secret env is unset is 503, names the variable and starts no run", async () => {
    const { engine, runner } = build([route()], { secret: () => undefined });
    const out = await engine.deliver(delivery(githubSigned(issue("d-4"))));
    expect(out.status).toBe(503);
    expect(out.body).toContain(SECRET_ENV);
    expect(runner.inputs).toHaveLength(0);
  });

  it("verifies Stripe's t/v1 scheme and refuses a timestamp outside the tolerance", async () => {
    const stripe = route({ name: "stripe-paid", path: "/hooks/stripe", signature: "stripe", objective_template: "Invoice {{payload.data.object.id}} was paid", dedupe_key: "{{payload.id}}" });
    const { engine, runner, clock } = build([stripe]);
    const event = { id: "evt_1", type: "invoice.paid", data: { object: { id: "in_9" } } };
    const ok = await engine.deliver(delivery(stripeSigned(event, clock.now), { path: "/hooks/stripe" }));
    expect(ok.status).toBe(202);
    const stale = await engine.deliver(delivery(stripeSigned({ ...event, id: "evt_2" }, new Date(clock.now.getTime() - 301_000)), { path: "/hooks/stripe" }));
    expect(stale.status).toBe(401);
    expect(runner.inputs).toHaveLength(1);
  });

  // [C8] The generic scheme bound to a timestamp: past tolerance, a valid MAC is still a replay.
  it("hmac-sha256-ts: a fresh delivery starts a run, the same one correctly signed 301 s ago is 401", async () => {
    const acme = route({ name: "acme", path: "/hooks/acme", signature: "hmac-sha256-ts", objective_template: "Acme event {{payload.id}}", dedupe_key: "{{payload.id}}" });
    const { engine, runner, clock, profileDir } = build([acme]);
    const fresh = await engine.deliver(delivery(timestampSigned({ id: "evt_ts_1", type: "order.paid" }, clock.now), { path: "/hooks/acme" }));
    expect(fresh.status).toBe(202);
    const old = new Date(clock.now.getTime() - 301_000);
    const stale = await engine.deliver(delivery(timestampSigned({ id: "evt_ts_2", type: "order.paid" }, old), { path: "/hooks/acme" }));
    const staleInline = await engine.deliver(delivery(timestampSigned({ id: "evt_ts_3", type: "order.paid" }, old, { inline: true }), { path: "/hooks/acme" }));
    expect([stale.status, staleInline.status]).toEqual([401, 401]);
    expect(runner.inputs).toHaveLength(1);
    expect(readDeliveries(profileDir, 10).filter((row) => row.verdict === "bad_signature").map((row) => row.status)).toEqual([401, 401]);
  });
});

describe("H3 webhook routes: replay and dedupe", () => {
  it("a replay within 24 h is 200 with the original run id and starts no second run", async () => {
    const { engine, runner, clock } = build();
    const first = json((await engine.deliver(delivery(githubSigned(issue("d-10"))))).body);
    clock.now = new Date(T0.getTime() + 23 * 3_600_000);
    const again = await engine.deliver(delivery(githubSigned(issue("d-10"))));
    expect(again.status).toBe(200);
    expect(json(again.body)).toMatchObject({ replay: true, run_id: first.run_id });
    expect(runner.inputs).toHaveLength(1);
  });

  it("the same key after 24 h starts a new run", async () => {
    const { engine, runner, clock } = build();
    await engine.deliver(delivery(githubSigned(issue("d-11"))));
    clock.now = new Date(T0.getTime() + 25 * 3_600_000);
    const later = await engine.deliver(delivery(githubSigned(issue("d-11"))));
    expect(later.status).toBe(202);
    expect(runner.inputs).toHaveLength(2);
  });

  it("dedupe survives a restart: a new engine on the same profile answers the replay", async () => {
    const a = build();
    const first = json((await a.engine.deliver(delivery(githubSigned(issue("d-12"))))).body);
    await a.engine.idle();
    const b = build([route()], { profileDir: a.profileDir });
    const again = await b.engine.deliver(delivery(githubSigned(issue("d-12"))));
    expect(again.status).toBe(200);
    expect(json(again.body).run_id).toBe(first.run_id);
    expect(b.runner.inputs).toHaveLength(0);
  });

  it("two identical deliveries at once start one run", async () => {
    const { engine, runner } = build();
    const [x, y] = await Promise.all([engine.deliver(delivery(githubSigned(issue("d-13")))), engine.deliver(delivery(githubSigned(issue("d-13"))))]);
    expect([x.status, y.status].sort()).toEqual([200, 202]);
    expect(json(x.body).run_id).toBe(json(y.body).run_id);
    expect(runner.inputs).toHaveLength(1);
  });

  it("without a dedupe_key the raw body is the key", async () => {
    const { engine, runner } = build([route({ dedupe_key: undefined })]);
    await engine.deliver(delivery(githubSigned(issue("d-14"))));
    const again = await engine.deliver(delivery(githubSigned(issue("d-14"))));
    expect(again.status).toBe(200);
    expect(runner.inputs).toHaveLength(1);
  });

  it("a run that never started releases its key, so the retry starts one", async () => {
    const failing = recordingRunner({ fail: new Error("runtime is down") });
    const { engine, profileDir } = build([route()], { runner: failing });
    const out = await engine.deliver(delivery(githubSigned(issue("d-15"))));
    expect(out.status).toBe(502);
    const healthy = recordingRunner();
    const b = build([route()], { profileDir, runner: healthy });
    expect((await b.engine.deliver(delivery(githubSigned(issue("d-15"))))).status).toBe(202);
  });
});

describe("H3 webhook routes: localhost-only", () => {
  const open = route({ name: "local", path: "/hooks/local", signature: "none-localhost-only", secret_env: undefined, objective_template: "Local job {{payload.job}}", dedupe_key: undefined });

  it("refuses a non-loopback peer with 403 and starts no run", async () => {
    const { engine, runner } = build([open]);
    const out = await engine.deliver(delivery({ body: Buffer.from('{"job":"x"}'), headers: {} }, { path: "/hooks/local", peer: "10.0.0.5" }));
    expect(out.status).toBe(403);
    expect(runner.inputs).toHaveLength(0);
  });

  it("refuses a loopback peer when the listener itself is not bound to loopback", async () => {
    const { engine, runner } = build([open]);
    const out = await engine.deliver(delivery({ body: Buffer.from('{"job":"x"}'), headers: {} }, { path: "/hooks/local", boundAddress: "0.0.0.0" }));
    expect(out.status).toBe(403);
    expect(runner.inputs).toHaveLength(0);
  });

  // [C8] A loopback route now takes content-type application/json only (the requirement changed:
  // council C8), so the script's request names its type.
  it("accepts an unsigned loopback request on a loopback listener", async () => {
    const { engine, runner } = build([open]);
    const out = await engine.deliver(delivery({ body: Buffer.from('{"job":"nightly"}'), headers: { "content-type": "application/json; charset=utf-8" } }, { path: "/hooks/local", peer: "::ffff:127.0.0.1" })); // [C8]
    expect(out.status).toBe(202);
    expect(runner.inputs[0]?.objective).toContain("Local job nightly");
  });

  // [C8] A page in the owner's browser posts from 127.0.0.1 too; the browser always names its Origin.
  it("refuses a loopback POST carrying an Origin header with 403, records why, and starts no run", async () => {
    const { engine, runner, profileDir } = build([open]);
    for (const origin of ["https://evil.test", "null"]) {
      const out = await engine.deliver(delivery({ body: Buffer.from('{"job":"x"}'), headers: { "content-type": "application/json", origin } }, { path: "/hooks/local" }));
      expect(out.status).toBe(403);
    }
    expect(runner.inputs).toHaveLength(0);
    const rows = readDeliveries(profileDir, 10);
    expect(rows.map((row) => [row.verdict, row.status])).toEqual([["browser_origin", 403], ["browser_origin", 403]]);
    expect(rows[0]?.detail).toContain("https://evil.test");
  });

  // [C8] A form (enctype text/plain) or a no-cors fetch can post JSON-looking text with no preflight.
  it("refuses a text/plain or untyped body, and a body that does not parse, with 403 and no run", async () => {
    const { engine, runner, profileDir } = build([open]);
    const post = (body: string, headers: Record<string, string>) => engine.deliver(delivery({ body: Buffer.from(body), headers }, { path: "/hooks/local" }));
    expect((await post('{"job":"x","a":"="}', { "content-type": "text/plain" })).status).toBe(403);
    expect((await post('{"job":"x"}', {})).status).toBe(403);
    expect((await post("{not json", { "content-type": "application/json" })).status).toBe(403);
    expect(runner.inputs).toHaveLength(0);
    const rows = readDeliveries(profileDir, 10);
    expect(rows.map((row) => [row.verdict, row.status])).toEqual([["not_json", 403], ["not_json", 403], ["not_json", 403]]);
    expect(rows[0]?.detail).toContain("text/plain");
  });

  // [C8] Beyond the brief: a tunnel or reverse proxy on this host connects from loopback too, and
  // one that says so (a forwarding header) is not a local caller.
  it("refuses a loopback POST that a proxy forwarded, with 403 and no run", async () => {
    const { engine, runner, profileDir } = build([open]);
    for (const name of ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"]) {
      const out = await engine.deliver(delivery({ body: Buffer.from('{"job":"x"}'), headers: { "content-type": "application/json", [name]: "203.0.113.9" } }, { path: "/hooks/local" }));
      expect(out.status).toBe(403);
    }
    expect(runner.inputs).toHaveLength(0);
    expect(readDeliveries(profileDir, 10).map((row) => row.verdict)).toEqual(["not_loopback", "not_loopback", "not_loopback", "not_loopback"]);
  });
});

describe("H3 webhook routes: what the run receives", () => {
  it("renders the objective template from the JSON body", async () => {
    const { engine, runner } = build();
    await engine.deliver(delivery(githubSigned(issue("d-20", "Refunds fail on EU cards"))));
    expect(runner.inputs[0]?.objective).toContain("Triage GitHub issue #42: Refunds fail on EU cards");
  });

  it("tags the run's first message as untrusted inbound provenance", async () => {
    const { engine, runner } = build();
    await engine.deliver(delivery(githubSigned(issue("d-21"))));
    const input = runner.inputs[0]!;
    expect(input.objective.startsWith("[provenance: untrusted via webhook:gh-issues]")).toBe(true);
    expect(input.provenance).toBe("untrusted");
    expect(input.inbound).toBe("webhook:gh-issues");
  });

  it("seeds the run's policy ring on its first frame, before the next frame is read", async () => {
    const runner = recordingRunner({ costs: [1] });
    const seeded: Array<[string, string]> = [];
    const { engine } = build([route()], {
      runner,
      seedInbound: (runId, source) => {
        seeded.push([runId, source]);
        runner.log.push("seed");
      },
    });
    const out = json((await engine.deliver(delivery(githubSigned(issue("d-22"))))).body);
    await engine.idle();
    expect(seeded).toEqual([[out.run_id, "webhook:gh-issues"]]);
    expect(runner.log.slice(0, 3)).toEqual(["frame:run_start", "seed", "frame:step_end:1"]);
  });

  it("a seeded ring makes send-after-untrusted ask before a send in that run, and only in that run", async () => {
    const policy = new PolicyDispatcher();
    await seedInboundTaint(policy, "run_seeded", "webhook:gh-issues");
    const send = { adapter: "business", scopes: ["business"], tool: "sms_send", args: { to: "+15550100", body: "hi" } };
    const inRun = await runWithToolCallContext({ runId: "run_seeded", stepId: "s1" }, async () => policy.decide(send));
    const other = await runWithToolCallContext({ runId: "run_other", stepId: "s1" }, async () => policy.decide(send));
    expect(inRun?.rule.id).toBe("send-after-untrusted");
    expect(inRun?.effect).toBe("require_approval");
    expect(other).toBeUndefined();
  });

  it("the seed classifies as an inbound read and nothing else, whatever the route is called", () => {
    expect(classifyCall(INBOUND_SEED_CALL)).toEqual(["inbound"]);
  });

  it("hands the route's cost cap, mode and seat to the runner", async () => {
    const solo = recordingRunner();
    const fleet = recordingRunner();
    const { engine } = build([route({ mode: "solo", seat: "support-responder", max_cost_cents: 75 })], { runnerFor: (mode) => (mode === "solo" ? solo : fleet) });
    await engine.deliver(delivery(githubSigned(issue("d-23"))));
    expect(fleet.inputs).toHaveLength(0);
    expect(solo.inputs[0]).toMatchObject({ maxCostCents: 75, mode: "solo", seat: "support-responder", surface: "webhook" });
  });

  it("stops the run when its metered frames reach the cost cap", async () => {
    const runner = recordingRunner({ costs: [40, 40, 40] });
    const { engine, profileDir } = build([route({ max_cost_cents: 60 })], { runner });
    await engine.deliver(delivery(githubSigned(issue("d-24"))));
    await engine.idle();
    expect(runner.inputs[0]?.signal.aborted).toBe(true);
    expect(runner.log).not.toContain("frame:step_end:3");
    expect(readDeliveries(profileDir, 10).at(-1)).toMatchObject({ verdict: "cost_cap", route: "gh-issues" });
  });

  it("a route whose mode has no runner is 503 and starts nothing", async () => {
    const { engine } = build([route({ mode: "solo" })], { runnerFor: () => undefined });
    const out = await engine.deliver(delivery(githubSigned(issue("d-25"))));
    expect(out.status).toBe(503);
    expect(out.body).toContain("solo");
  });
});

describe("H3 webhook routes: slow and failing starts", () => {
  it("a run slower than the first-frame timeout is answered 202 without a run id, and the store learns it later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = recordingRunner();
    const runner: RecordingRunner = {
      inputs: inner.inputs,
      log: inner.log,
      run(input) {
        const frames = inner.run(input);
        return (async function* delayed() {
          await gate;
          yield* frames;
        })();
      },
    };
    const { engine, profileDir } = build([route()], { runner, firstFrameTimeoutMs: 10 });
    const out = await engine.deliver(delivery(githubSigned(issue("d-50"))));
    expect(out.status).toBe(202);
    expect(json(out.body).run_id).toBeNull();
    release();
    await engine.idle();
    const rows = readDeliveries(profileDir, 10);
    expect(rows.map((row) => row.verdict)).toEqual(["started", "completed"]);
    expect(rows[0]?.run_id).toBeUndefined();
    expect(rows[1]?.run_id).toMatch(/^run_h3_\d+$/);
    const again = await engine.deliver(delivery(githubSigned(issue("d-50"))));
    expect(json(again.body)).toMatchObject({ replay: true, run_id: rows[1]?.run_id });
    expect(runner.inputs).toHaveLength(1);
  });

  it("a seed that fails stops the run and answers 502, so the delivery is retried", async () => {
    const runner = recordingRunner({ costs: [1, 1] });
    const { engine } = build([route()], {
      runner,
      seedInbound: () => {
        throw new Error("no policy ring");
      },
    });
    const out = await engine.deliver(delivery(githubSigned(issue("d-51"))));
    expect(out.status).toBe(502);
    expect(runner.inputs[0]?.signal.aborted).toBe(true);
    expect(runner.log).not.toContain("frame:step_end:1");
  });
});

describe("H3 webhook routes: the rest of the gate", () => {
  it("rate-limits each route per minute", async () => {
    const { engine, runner, clock } = build([route({ rate_per_minute: 1 })]);
    expect((await engine.deliver(delivery(githubSigned(issue("d-30"))))).status).toBe(202);
    const limited = await engine.deliver(delivery(githubSigned(issue("d-31"))));
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBeDefined();
    clock.now = new Date(T0.getTime() + 61_000);
    expect((await engine.deliver(delivery(githubSigned(issue("d-32"))))).status).toBe(202);
    expect(runner.inputs).toHaveLength(2);
  });

  it("a malformed body is 400 after the signature passes, and starts no run", async () => {
    const { engine, runner } = build();
    const body = Buffer.from("{not json");
    const out = await engine.deliver(delivery({ body, headers: { "x-hub-signature-256": `sha256=${hmacHex(SECRET, body)}` } }));
    expect(out.status).toBe(400);
    expect(runner.inputs).toHaveLength(0);
  });

  it("an event the route does not list is 200 ignored, and starts no run", async () => {
    const { engine, runner } = build([route({ events: ["pull_request"] })]);
    const out = await engine.deliver(delivery(githubSigned(issue("d-33"))));
    expect(out.status).toBe(200);
    expect(json(out.body)).toMatchObject({ ignored: true });
    expect(runner.inputs).toHaveLength(0);
  });

  it("only POST starts a run; an unknown path is not this engine's", async () => {
    const { engine, runner } = build();
    expect((await engine.deliver(delivery(githubSigned(issue("d-34")), { method: "GET" }))).status).toBe(405);
    expect(engine.match("/hooks/nope")).toBeUndefined();
    expect(engine.match("/hooks/gh-issues")?.name).toBe("gh-issues");
    expect(runner.inputs).toHaveLength(0);
  });
});

describe("H3 webhook routes: the delivery store", () => {
  it("records route, dedupe key, run id and verdict for each delivery", async () => {
    const { engine, profileDir } = build();
    const first = json((await engine.deliver(delivery(githubSigned(issue("d-40"))))).body);
    await engine.deliver(delivery(githubSigned(issue("d-41"), "the-wrong-secret")));
    await engine.deliver(delivery(githubSigned(issue("d-40"))));
    await engine.idle();
    const rows = readDeliveries(profileDir, 10);
    expect(rows.map((row) => row.verdict)).toEqual(["started", "bad_signature", "replay", "completed"]);
    expect(rows[0]).toMatchObject({ route: "gh-issues", key: "d-40", run_id: first.run_id, status: 202 });
    expect(rows[1]).toMatchObject({ route: "gh-issues", status: 401 });
    expect(rows[1]?.run_id).toBeUndefined();
    expect(rows[2]).toMatchObject({ key: "d-40", run_id: first.run_id, status: 200 });
    expect(rows[3]).toMatchObject({ key: "d-40", run_id: first.run_id });
    const mode = fs.statSync(`${profileDir}/webhooks/deliveries.jsonl`).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never writes the secret or the raw body into the store", async () => {
    const { engine, profileDir } = build();
    await engine.deliver(delivery(githubSigned(issue("d-42", "a title only the body has"))));
    await engine.idle();
    const text = fs.readFileSync(`${profileDir}/webhooks/deliveries.jsonl`, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("a title only the body has");
  });
});
