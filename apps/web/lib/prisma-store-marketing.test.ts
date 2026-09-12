import { describe, expect, it, vi } from "vitest";

const { mockMarketingAccountUpsert } = vi.hoisted(() => ({
  mockMarketingAccountUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(async () => []),
    marketingAccount: {
      upsert: mockMarketingAccountUpsert,
    },
  },
}));

import { prismaStoreMarketing } from "./prisma-store-marketing";

describe("prismaStoreMarketing", () => {
  it("does not reset omitted optional marketing account fields during upsert updates", async () => {
    mockMarketingAccountUpsert.mockResolvedValue({
      id: "mktacct_1",
      companyId: "co_1",
      platform: "meta",
      status: "paused",
      externalAccountId: "act_2",
      externalBusinessId: "biz_1",
      currency: "CAD",
      dailyBudgetCents: 5000,
      paymentStatus: "blocked",
      consentForServerEvents: true,
      createdAt: new Date("2026-05-29T00:00:00.000Z"),
      updatedAt: new Date("2026-05-29T00:00:00.000Z"),
    });

    await prismaStoreMarketing.upsertMarketingAccount({
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_2",
    });

    expect(mockMarketingAccountUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {
        externalAccountId: "act_2",
      },
    }));
  });
});
