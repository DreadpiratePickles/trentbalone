import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockGetUserCompanyIds,
  mockDbFindMany,
  mockStoreGetCompany,
  mockStoreListCompanies,
  mockStoreCreateCompany,
  mockCreateOwnerMembership,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockGetUserCompanyIds: vi.fn(),
  mockDbFindMany: vi.fn(),
  mockStoreGetCompany: vi.fn(),
  mockStoreListCompanies: vi.fn(),
  mockStoreCreateCompany: vi.fn(),
  mockCreateOwnerMembership: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  getUserCompanyIds: mockGetUserCompanyIds,
  createOwnerMembership: mockCreateOwnerMembership,
  unauthorized: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    company: {
      findMany: mockDbFindMany,
    },
  },
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockStoreGetCompany,
    listCompanies: mockStoreListCompanies,
    createCompany: mockStoreCreateCompany,
  },
}));

import { GET } from "./route";

function prismaCompany(overrides: { id: string; name: string; slug: string; status?: string }) {
  return {
    id: overrides.id,
    name: overrides.name,
    slug: overrides.slug,
    website: null,
    status: overrides.status ?? "active",
    autonomyLevel: "supervised",
    publicVisibility: false,
    publicSubdomain: null,
    timezone: "UTC",
    budgetCents: 0,
    weeklyBudgetCents: null,
    nightlyRunHour: null,
    approvalExpiryOverrides: {},
    cycleFrequency: "weekly",
    lastCycleAt: null,
    nextCycleAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    brief: { vision: "active" },
    metrics: {},
  };
}

describe("/api/companies", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://test");
    mockGetAuthUser.mockReset();
    mockGetUserCompanyIds.mockReset();
    mockDbFindMany.mockReset();
    mockStoreGetCompany.mockReset();
    mockStoreListCompanies.mockReset();
    mockStoreCreateCompany.mockReset();
    mockCreateOwnerMembership.mockReset();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "u@example.com" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses DB-filtered active company rows instead of raw membership IDs", async () => {
    mockGetUserCompanyIds.mockResolvedValue(["co_active", "co_archived"]);
    mockDbFindMany.mockResolvedValue([
      prismaCompany({ id: "co_active", name: "Active Co", slug: "active-co" }),
    ]);
    mockStoreGetCompany.mockImplementation(async (id: string) => ({
      id,
      name: id === "co_archived" ? "Archived Co" : "Active Co",
      status: id === "co_archived" ? "archived" : "active",
    }));

    const res = await GET();
    const body = await res.json() as { companies: Array<{ id: string; status: string }> };

    expect(res.status).toBe(200);
    expect(body.companies).toHaveLength(1);
    expect(body.companies[0]?.id).toBe("co_active");
    expect(mockStoreGetCompany).not.toHaveBeenCalled();
  });
});
