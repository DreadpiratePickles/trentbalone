/**
 * lib/provisioning/expo-provisioner.test.ts — TDD
 *
 * EAS Build pipeline per company: project creation, build profile, OTA channels,
 * push notification credentials setup.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type ExpoApiClient,
  type ExpoProvisionedResource,
} from "@/lib/provisioning/expo-provisioner";
import { store } from "@/lib/store";

const FAKE: ExpoProvisionedResource = {
  projectId: "expo-proj-abc123",
  projectSlug: "acme-co",
  easProjectUrl: "https://expo.dev/@trent-platform/acme-co",
  otaChannels: ["production", "staging", "preview"],
  pushCredentialsConfigured: false,
};

function makeClient(overrides?: Partial<ExpoApiClient>): ExpoApiClient {
  return {
    createProject: vi.fn().mockResolvedValue({ projectId: FAKE.projectId, easProjectUrl: FAKE.easProjectUrl }),
    configureOtaChannels: vi.fn().mockResolvedValue({ channels: FAKE.otaChannels }),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Expo provisioner — provision()", () => {
  it("creates EAS project and configures OTA channels", async () => {
    const company = await store.createCompany({
      name: `Expo Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const result = await provision({ companyId: company.id, companySlug: "acme-co" }, client);

    expect(result.projectId).toBe(FAKE.projectId);
    expect(result.otaChannels).toContain("production");
    expect(client.createProject).toHaveBeenCalledOnce();
    expect(client.configureOtaChannels).toHaveBeenCalledOnce();
  });

  it("stores integration record and writes mobile.provision audit", async () => {
    const company = await store.createCompany({
      name: `Expo Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    expect(await store.getIntegration(company.id, "Expo-Provisioned")).toBeDefined();
    expect(after.filter((a) => !before.find((b) => b.id === a.id)).some((e) => e.action === "mobile.provision")).toBe(true);
  });
});

describe("Expo provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Expo Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createProject).not.toHaveBeenCalled();
    expect(second.projectId).toBe(first.projectId);
  });
});

describe("Expo provisioner — partial failure rollback", () => {
  it("deletes project if configureOtaChannels fails", async () => {
    const company = await store.createCompany({
      name: `Expo OtaFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({ configureOtaChannels: vi.fn().mockRejectedValue(new Error("OTA failed")) });

    await expect(provision({ companyId: company.id, companySlug: "acme-fail" }, client)).rejects.toThrow();
    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Expo-Provisioned")).toBeFalsy();
  });
});

describe("Expo provisioner — rollback()", () => {
  it("deletes project and removes record", async () => {
    const company = await store.createCompany({
      name: `Expo Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await provision({ companyId: company.id, companySlug: "acme-rb" }, client);
    vi.clearAllMocks();
    await rollback({ companyId: company.id, projectId: FAKE.projectId }, client);

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Expo-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `Expo RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await expect(rollback({ companyId: company.id, projectId: "nope" }, client)).resolves.not.toThrow();
    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

describe("Expo provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Expo StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });
});
