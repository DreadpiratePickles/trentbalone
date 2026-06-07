import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlotEnvironment } from "@/lib/agent-catalog";
import {
  GitNexusVaultIndexAdapter,
  LocalVaultMemoryProvider,
  buildVaultMemoryNamespace,
  vaultMemoryToolScopes,
} from "@/lib/vault-memory";
import { store } from "@/lib/store";

describe("Vault memory provider", () => {
  it("scopes memory writes by company, seat, agent, and artifact while mirroring markdown locally", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "trent-vault-"));
    const company = await store.createCompany({
      name: "Vault Memory Co",
      brief: { vision: "Keep durable scoped memory" },
    });
    const provider = new LocalVaultMemoryProvider({ rootDir: root, store });

    const record = await provider.write({
      companyId: company.id,
      role: "engineer",
      agentId: "eng-backend-architect",
      artifactId: "artifact_123",
      type: "agent_note",
      title: "Auth architecture decision",
      content: "Use scoped vault memory for durable context.",
      source: "test",
    });

    expect(record.namespace).toBe(
      `company:${company.id}/agent:engineer/profile:eng-backend-architect/artifact:artifact_123`,
    );
    expect(record.document.source).toContain("vault:");
    expect(record.document.companyId).toBe(company.id);
    expect(record.vaultPath).toContain(company.id);
    expect(record.vaultPath).toContain("engineer");

    const mirrored = await fs.readFile(record.vaultPath, "utf8");
    expect(mirrored).toContain("namespace: company:");
    expect(mirrored).toContain("role: engineer");
    expect(mirrored).toContain("agentId: eng-backend-architect");
    expect(mirrored).toContain("artifactId: artifact_123");
    expect(mirrored).toContain("Use scoped vault memory");
  });

  it("exposes safe GitNexus indexed-memory scopes to every runtime seat", () => {
    for (const role of ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"] as const) {
      const environment = buildSlotEnvironment("co_vault", role);
      expect(environment.tools).toEqual(expect.arrayContaining(vaultMemoryToolScopes()));
      expect(environment.approvalRequiredFor).toEqual(expect.arrayContaining([
        "vault.reindex",
        "vault.export",
        "vault.delete",
        "gitnexus.analyze",
        "gitnexus.clean",
      ]));
    }
  });
});

describe("GitNexus vault index adapter", () => {
  it("keeps read/search available while approval-gating reindex, export, and delete actions", () => {
    const adapter = new GitNexusVaultIndexAdapter({ vaultRoot: "/tmp/trent-vault" });

    expect(adapter.requiresApproval("search")).toBe(false);
    expect(adapter.requiresApproval("graph")).toBe(false);
    expect(adapter.requiresApproval("reindex")).toBe(true);
    expect(adapter.requiresApproval("export")).toBe(true);
    expect(adapter.requiresApproval("delete")).toBe(true);
    expect(adapter.requiresApproval("clean")).toBe(true);
  });

  it("builds local GitNexus commands against the company vault path without external writes by default", async () => {
    const adapter = new GitNexusVaultIndexAdapter({ vaultRoot: "/tmp/trent-vault" });

    expect(adapter.buildAnalyzeCommand("co_123")).toEqual({
      command: "npx",
      args: ["-y", "gitnexus@latest", "analyze", "/tmp/trent-vault/co_123", "--skip-agents-md", "--skip-git"],
    });

    const result = await adapter.execute("search", { companyId: "co_123", query: "pricing decision" });
    expect(result.status).toBe("mocked");
    expect(result.summary).toContain("GitNexus Vault search");
    expect(result.summary).toContain("local-only");
  });
});

describe("buildVaultMemoryNamespace", () => {
  it("omits missing optional scopes without losing company isolation", () => {
    expect(buildVaultMemoryNamespace({ companyId: "co_1" })).toBe("company:co_1");
    expect(buildVaultMemoryNamespace({ companyId: "co_1", role: "support" })).toBe("company:co_1/agent:support");
  });
});
