import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  forbidden: () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
}));

const {
  mockGetCompany,
  mockListInvoices,
  mockListLedgerEntries,
  mockListPayoutHolds,
  mockCreatePayoutHold,
} = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockListInvoices: vi.fn(),
  mockListLedgerEntries: vi.fn(),
  mockListPayoutHolds: vi.fn(),
  mockCreatePayoutHold: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listInvoices: mockListInvoices,
    listLedgerEntries: mockListLedgerEntries,
    listPayoutHolds: mockListPayoutHolds,
    createPayoutHold: mockCreatePayoutHold,
  },
}));

const { mockGetUnbilledUsage } = vi.hoisted(() => ({
  mockGetUnbilledUsage: vi.fn(),
}));

vi.mock("@/lib/payments/usage-meter", () => ({
  getUnbilledUsage: mockGetUnbilledUsage,
}));

const { mockEscalateDispute } = vi.hoisted(() => ({
  mockEscalateDispute: vi.fn(),
}));

vi.mock("@/lib/payments/dispute-handler", () => ({
  escalateDispute: mockEscalateDispute,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  rateLimitExceeded: () => new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 }),
}));

vi.mock("@/lib/rls", () => ({
  setCompanyContext: vi.fn(),
  clearCompanyContext: vi.fn(),
}));

// ── imports ──────────────────────────────────────────────────────────────────

import { GET as getInvoices } from "./invoices/route";
import { GET as getHistory } from "./history/route";
import { GET as getUsage } from "./usage/route";
import { GET as getHolds } from "./holds/route";
import { POST as postDispute } from "./disputes/route";

// ── fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_ID = "company_trent_demo";
const MOCK_COMPANY = { id: COMPANY_ID, name: "Trent Demo" };
const mockParams = { params: Promise.resolve({ id: COMPANY_ID }) };

function makeRequest(url = `http://localhost/api/companies/${COMPANY_ID}/billing`, body?: object) {
  return new Request(
    url,
    body
      ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Billing API Routes", () => {
  beforeEach(() => {
    mockGetAuthUser.mockResolvedValue({ id: "user_test", email: "test@example.com" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue(MOCK_COMPANY);
    mockListInvoices.mockResolvedValue([]);
    mockListLedgerEntries.mockResolvedValue([]);
    mockListPayoutHolds.mockResolvedValue([]);
    mockGetUnbilledUsage.mockResolvedValue({ totalCents: 0, items: [] });
    mockEscalateDispute.mockResolvedValue({ id: "approval_1", action: "resolve_dispute" });
  });

  it("GET /invoices returns empty list", async () => {
    const res = await getInvoices(makeRequest(), mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.invoices)).toBe(true);
  });

  it("GET /history returns empty list", async () => {
    const res = await getHistory(makeRequest(), mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.ledgerEntries)).toBe(true);
  });

  it("GET /usage returns totalCents and items", async () => {
    const res = await getUsage(makeRequest(), mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty("totalCents");
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("billingPeriod");
  });

  it("GET /holds returns only held holds", async () => {
    mockListPayoutHolds.mockResolvedValue([
      { id: "hold_1", companyId: COMPANY_ID, status: "held", amountCents: 500 },
      { id: "hold_2", companyId: COMPANY_ID, status: "released", amountCents: 200 },
    ]);
    const res = await getHolds(makeRequest(), mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.holds)).toBe(true);
    expect(body.holds.every((h: any) => h.status === "held")).toBe(true);
  });

  it("POST /disputes creates approval", async () => {
    const req = makeRequest(undefined, { txHash: "0xtest", amountCents: 100, counterpartyWallet: "0xwallet" });
    const res = await postDispute(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.approval).toBeDefined();
    expect(body.approval.action).toBe("resolve_dispute");
  });

  it("POST /disputes returns 400 when body is missing fields", async () => {
    const req = makeRequest(undefined, { txHash: "0xtest" });
    const res = await postDispute(req, mockParams);
    expect(res.status).toBe(400);
  });

  it("GET /invoices returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValueOnce(null as any);
    const res = await getInvoices(makeRequest(), mockParams);
    expect(res.status).toBe(401);
  });

  it("GET /invoices returns 403 when insufficient role", async () => {
    mockRequireRoleForRequest.mockResolvedValueOnce({ ok: false } as any);
    const res = await getInvoices(makeRequest(), mockParams);
    expect(res.status).toBe(403);
  });
});
