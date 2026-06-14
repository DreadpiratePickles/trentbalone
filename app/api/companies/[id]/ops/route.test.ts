import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

import { GET } from "./route";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

async function seedRun(companyId: string, objective: string) {
  const id = makeId("orc");
  await store.createOrchestratorRun({
    id,
    companyId,
    objective,
    trigger: "manual",
    status: "completed" as never,
    modelPolicy: {},
    budgetCents: 100,
    costCents: 0,
    summary: undefined,
  });
  await store.upsertOrchestratorStep({
    id: `${id}-s1`, runId: id, companyId, seq: 1, title: "step", rationale: "x",
    agentRole: "analyst", dependsOn: [], expectedOutput: "y", riskLevel: "low",
    needsApproval: false, status: "completed", output: "ok",
  });
  return id;
}

function req(companyId: string, runId?: string) {
  const url = `http://x/api/companies/${companyId}/ops${runId ? `?runId=${runId}` : ""}`;
  return new Request(url);
}

describe("GET /api/companies/[id]/ops", () => {
  let companyA: string;
  let companyB: string;
  let runA: string;
  let runB: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const a = await store.createCompany({ name: `Ops A ${makeId("t")}`, brief: { vision: "a" } });
    const b = await store.createCompany({ name: `Ops B ${makeId("t")}`, brief: { vision: "b" } });
    companyA = a.id;
    companyB = b.id;
    runA = await seedRun(companyA, "Company A objective");
    runB = await seedRun(companyB, "Company B objective");
  });

  it("returns only the requesting company's runs (no cross-company leak)", async () => {
    const res = await GET(req(companyA), { params: Promise.resolve({ id: companyA }) });
    expect(res.status).toBe(200);
    const data = await res.json();

    const ids = data.recentRuns.map((r: { id: string }) => r.id);
    expect(ids).toContain(runA);
    expect(ids).not.toContain(runB);
    expect(data.recentRuns.every((r: { objective: string }) => r.objective === "Company A objective")).toBe(true);
  });

  it("selects the requested run and returns its evidence/trust/diagnostics", async () => {
    const res = await GET(req(companyA, runA), { params: Promise.resolve({ id: companyA }) });
    const data = await res.json();
    expect(data.selectedRun.summary.id).toBe(runA);
    expect(data.selectedRun).toHaveProperty("evidenceLedger");
    expect(data.selectedRun).toHaveProperty("trustSummary");
    expect(Array.isArray(data.selectedRun.diagnostics)).toBe(true);
  });

  it("401s without a user and 403s without the viewer role", async () => {
    mockGetAuthUser.mockResolvedValueOnce(null);
    expect((await GET(req(companyA), { params: Promise.resolve({ id: companyA }) })).status).toBe(401);

    mockGetAuthUser.mockResolvedValueOnce({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValueOnce({ ok: false });
    expect((await GET(req(companyA), { params: Promise.resolve({ id: companyA }) })).status).toBe(403);
  });
});
