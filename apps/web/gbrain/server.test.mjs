import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.mjs";
import { createStore } from "./store.mjs";

const API_KEY = "gb_test_key";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function call(port, method, path, { body, apiKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe("gbrain sidecar server", () => {
  let server;
  let port;

  before(async () => {
    server = createServer({ store: createStore(), apiKey: API_KEY });
    port = await listen(server);
  });

  after(() => server.close());

  it("reports health without auth", async () => {
    const res = await call(port, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "ok");
  });

  it("rejects unauthorized writes", async () => {
    const res = await call(port, "POST", "/ingest", { body: { companyId: "co_1", title: "x", content: "y" } });
    assert.equal(res.status, 401);
  });

  it("ingests a mission memory log and returns a documentId", async () => {
    const res = await call(port, "POST", "/ingest", {
      apiKey: API_KEY,
      body: { companyId: "co_1", runId: "run_1", title: "Launch A retro", content: "We used a product demo video and a referral push. Demo drove signups.", source: "agent-mission:run_1", tags: ["agent_mission", "memory_log"] },
    });
    assert.equal(res.status, 200);
    assert.match(res.json.documentId, /^gbdoc_/);
  });

  it("recalls relevant memory with citations", async () => {
    const res = await call(port, "POST", "/recall", {
      apiKey: API_KEY,
      body: { companyId: "co_1", query: "how did past launches with demos go" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.citations.length > 0);
    assert.equal(res.json.gaps.length, 0);
    assert.equal(res.json.citations[0].title, "Launch A retro");
  });

  it("reports a gap when nothing matches", async () => {
    const res = await call(port, "POST", "/recall", {
      apiKey: API_KEY,
      body: { companyId: "co_other", query: "quantum logistics pricing" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.citations.length, 0);
    assert.ok(res.json.gaps.length > 0);
  });

  it("rejects recall without a query", async () => {
    const res = await call(port, "POST", "/recall", { apiKey: API_KEY, body: { companyId: "co_1" } });
    assert.equal(res.status, 400);
  });

  it("advises using prior memory and never returns citations field", async () => {
    const res = await call(port, "POST", "/advise", {
      apiKey: API_KEY,
      body: { companyId: "co_1", objective: "launch a new demo-led campaign", question: "what worked before" },
    });
    assert.equal(res.status, 200);
    assert.ok(typeof res.json.guidance === "string" && res.json.guidance.length > 0);
    assert.ok(Array.isArray(res.json.clarifyingQuestions));
    assert.equal(res.json.citations, undefined);
  });

  it("404s unknown routes", async () => {
    const res = await call(port, "POST", "/nope", { apiKey: API_KEY, body: {} });
    assert.equal(res.status, 404);
  });
});
