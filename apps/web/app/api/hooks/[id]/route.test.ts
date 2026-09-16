import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { store } from "@/lib/store";
import { createWebhookWithSecret } from "@/lib/webhooks";

const { mockLaunchOrchestration } = vi.hoisted(() => ({ mockLaunchOrchestration: vi.fn() }));
vi.mock("@/lib/orchestrator", () => ({ launchOrchestration: mockLaunchOrchestration }));

import { POST } from "./route";

const secret = "whsec_inbound_0123456789abcdef";

async function setup(action: "create_task" | "start_run" = "create_task") {
  const company = await store.createCompany({ name: `Hooks ${Date.now()}`, brief: { vision: "inbound hooks" }, budgetCents: 1000 });
  const webhook = await createWebhookWithSecret({ companyId: company.id, url: "https://r.test/h", events: [], secret, action });
  return { company, webhook };
}

function post(id: string, body: string | Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`http://x/api/hooks/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const auth = { authorization: `Bearer ${secret}` };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/hooks/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLaunchOrchestration.mockResolvedValue({ id: "orc_1", status: "planning" });
  });

  it("signature: rejects a missing or wrong bearer secret without revealing whether the hook exists", async () => {
    const { webhook } = await setup();
    const missing = await POST(post(webhook.id, { event: "task.create", data: { title: "x" } }), params(webhook.id));
    expect(missing.status).toBe(401);
    const wrong = await POST(post(webhook.id, { event: "task.create", data: { title: "x" } }, { authorization: "Bearer nope" }), params(webhook.id));
    expect(wrong.status).toBe(401);
    const unknown = await POST(post("wh_missing", { event: "task.create", data: { title: "x" } }, auth), params("wh_missing"));
    expect(unknown.status).toBe(404);
  });

  it("malformed body: returns 400 for invalid JSON and for a body that fails the schema", async () => {
    const { webhook } = await setup();
    const notJson = await POST(post(webhook.id, "{not json", auth), params(webhook.id));
    expect(notJson.status).toBe(400);
    const badShape = await POST(post(webhook.id, { event: "task.create", data: { title: 42 } }, auth), params(webhook.id));
    expect(badShape.status).toBe(400);
    expect((await badShape.json()).error).toBe("invalid_body");
  });

  it("unsupported event: returns 422 for an unknown event and for one the hook's action does not accept", async () => {
    const { webhook } = await setup("create_task");
    const unknown = await POST(post(webhook.id, { event: "invoice.paid", data: {} }, auth), params(webhook.id));
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).error).toBe("unsupported_event");
    const mismatch = await POST(post(webhook.id, { event: "run.start", data: { objective: "ship" } }, auth), params(webhook.id));
    expect(mismatch.status).toBe(422);
  });

  it("idempotency: create_task creates a task and records the inbound receipt", async () => {
    const { company, webhook } = await setup("create_task");
    const res = await POST(
      post(webhook.id, { event: "task.create", data: { title: "Write launch email", priority: "high" } }, { ...auth, "x-trent-idempotency-key": "k-1" }),
      params(webhook.id),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.duplicate).toBe(false);
    expect(body.task.title).toBe("Write launch email");
    expect(body.task.companyId).toBe(company.id);
    const receipts = await store.listWebhookDeliveries(company.id, webhook.id);
    expect(receipts.some((r) => r.direction === "inbound" && r.idempotencyKey === "k-1" && r.status === "delivered")).toBe(true);
  });

  it("replay: the same idempotency key returns 200 duplicate:true and creates nothing new", async () => {
    const { company, webhook } = await setup("create_task");
    const headers = { ...auth, "x-trent-idempotency-key": "k-replay" };
    const first = await POST(post(webhook.id, { event: "task.create", data: { title: "Once" } }, headers), params(webhook.id));
    expect(first.status).toBe(201);
    const before = (await store.listTasks(company.id)).length;
    const replay = await POST(post(webhook.id, { event: "task.create", data: { title: "Once" } }, headers), params(webhook.id));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect((await store.listTasks(company.id)).length).toBe(before);
  });

  it("start_run launches an orchestration run with the objective", async () => {
    const { company, webhook } = await setup("start_run");
    const res = await POST(post(webhook.id, { event: "run.start", data: { objective: "Ship the pricing page" } }, auth), params(webhook.id));
    expect(res.status).toBe(201);
    expect(mockLaunchOrchestration).toHaveBeenCalledWith(expect.objectContaining({ companyId: company.id, objective: "Ship the pricing page" }));
    expect((await res.json()).run.id).toBe("orc_1");
  });

  it("rejects a disabled hook", async () => {
    const { company, webhook } = await setup();
    await store.updateWebhook(company.id, webhook.id, { enabled: false });
    const res = await POST(post(webhook.id, { event: "task.create", data: { title: "x" } }, auth), params(webhook.id));
    expect(res.status).toBe(404);
  });
});
