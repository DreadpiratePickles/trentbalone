import { describe, expect, it } from "vitest";
import { decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import {
  getCreativeCredentialMap,
  getCreativeApiKey,
  listCreativeConnectionStatuses,
  saveCreativeConnection,
} from "@/lib/creative-connections";

describe("creative app connections", () => {
  it("stores creative app credentials encrypted and exposes only masked status", async () => {
    const company = await store.createCompany({ name: "Creative Apps", brief: { vision: "test" } });

    const connection = await saveCreativeConnection(company.id, {
      app: "higgsfield",
      apiKey: "higgs_live_123456789",
    });

    expect(connection.provider).toBe("Higgsfield");
    expect(connection.scopes).toEqual(["creative:generate"]);
    expect(connection.status).toBe("connected");
    expect(connection.encryptedData).not.toContain("higgs_live_123456789");
    expect(decryptJson(connection.encryptedData ?? "")).toEqual({
      app: "higgsfield",
      apiKey: "higgs_live_123456789",
    });

    const statuses = await listCreativeConnectionStatuses(company.id);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        app: "higgsfield",
        provider: "Higgsfield",
        status: "connected",
        source: "company",
        apiKey: "higg...6789",
      }),
      expect.objectContaining({
        app: "hyperframes",
        status: "needs_credentials",
        source: "missing",
      }),
    ]));
    expect(JSON.stringify(statuses)).not.toContain("higgs_live_123456789");
    await expect(getCreativeCredentialMap(company.id)).resolves.toMatchObject({ higgsfield: true });
    await expect(getCreativeApiKey(company.id, "higgsfield")).resolves.toBe("higgs_live_123456789");
  });
});
