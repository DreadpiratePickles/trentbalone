import { describe, expect, it } from "vitest";
import { seedTrustPanelProofEvidence } from "@/lib/trust-panel-view";
import { store } from "@/lib/store";

describe("seedTrustPanelProofEvidence", () => {
  it("seeds proof evidence through the active store abstraction", async () => {
    const company = await store.createCompany({
      name: "Trust Panel Seed Proof",
      brief: { vision: "Prove trust panel evidence can seed without a direct Prisma dependency." },
    });

    await seedTrustPanelProofEvidence(company.id);

    await expect(store.listArtifacts(company.id)).resolves.toHaveLength(1);
    await expect(store.listApprovals(company.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "Resend: founder onboarding email" }),
    ]));
    await expect(store.listAuditLogs(company.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "memory.write" }),
    ]));
  });
});
