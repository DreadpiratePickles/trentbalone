import { describe, expect, it, vi } from "vitest";
import { createVercelAdapter } from "./vercel-adapter";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const ENV = { VERCEL_TOKEN: "vc-test-123" };

describe("Vercel adapter", () => {
  it("fails closed without a token", async () => {
    const fetchImpl = vi.fn();
    const adapter = createVercelAdapter({ env: {}, fetchImpl });
    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    const result = await adapter.execute("deploy", { name: "app", gitSource: { repo: "x/y" } });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("VERCEL_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("approval-gates deploys but not reads", async () => {
    const adapter = createVercelAdapter({ env: ENV, fetchImpl: vi.fn() });
    expect(adapter.requiresApproval("deploy")).toBe(true);
    expect(adapter.requiresApproval("rollback")).toBe(true);
    expect(adapter.requiresApproval("list projects")).toBe(false);
  });

  it("deploys from a git source as a PREVIEW by default (never auto-prod) with a request timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "dpl_1", url: "my-app-abc.vercel.app", readyState: "QUEUED" }));
    const adapter = createVercelAdapter({ env: ENV, fetchImpl });

    const result = await adapter.execute("deploy", { name: "my-app", gitSource: { repo: "acme/site", ref: "main" } });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("https://my-app-abc.vercel.app");
    expect(result.summary).toContain("(preview)");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.vercel.com/v13/deployments");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("my-app");
    expect(body.gitSource).toEqual({ type: "github", repo: "acme/site", ref: "main" });
    expect(body.target).toBeUndefined(); // preview, not production
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal); // request timeout
  });

  it("only targets production when explicitly requested", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "dpl_2", url: "my-app.vercel.app" }));
    const adapter = createVercelAdapter({ env: ENV, fetchImpl });
    const result = await adapter.execute("deploy", { name: "my-app", target: "production", gitSource: { repo: "a/b" } });
    expect(result.summary).toContain("(production)");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.target).toBe("production");
  });

  it("requires name and a source for deploys", async () => {
    const fetchImpl = vi.fn();
    const adapter = createVercelAdapter({ env: ENV, fetchImpl });
    const noName = await adapter.execute("deploy", { gitSource: { repo: "a/b" } });
    expect(noName.status).toBe("failed");
    expect(noName.summary).toContain("payload.name");

    const noSource = await adapter.execute("deploy", { name: "app" });
    expect(noSource.status).toBe("failed");
    expect(noSource.summary).toContain("payload.gitSource");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adds teamId to the URL when VERCEL_TEAM_ID is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ projects: [{ name: "site" }] }));
    const adapter = createVercelAdapter({ env: { ...ENV, VERCEL_TEAM_ID: "team_9" }, fetchImpl });
    await adapter.execute("list", {});
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.vercel.com/v9/projects?teamId=team_9");
  });

  it("surfaces Vercel API errors on deploy", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid project name" } }, false, 400));
    const adapter = createVercelAdapter({ env: ENV, fetchImpl });
    const result = await adapter.execute("deploy", { name: "BAD NAME", files: [{ file: "index.html", data: "<h1>hi</h1>" }] });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Invalid project name");
  });

  it("inline-file deploys include the required projectSettings and pass file encoding", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "d", url: "x.vercel.app" }));
    const adapter = createVercelAdapter({ env: ENV, fetchImpl });
    await adapter.execute("deploy", {
      name: "site",
      files: [
        { file: "index.html", data: "<h1>hi</h1>" },
        { file: "logo.png", data: "QUJD", encoding: "base64" },
      ],
    });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.projectSettings).toEqual({ framework: null }); // required for inline-file deploys
    expect(body.files).toEqual([
      { file: "index.html", data: "<h1>hi</h1>" },
      { file: "logo.png", data: "QUJD", encoding: "base64" },
    ]);
  });

  it("deploys under the company's OWN Vercel account when connected (multi-tenant)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "d", url: "co.vercel.app" }));
    const adapter = createVercelAdapter({
      env: { VERCEL_TOKEN: "vc-GLOBAL" },
      fetchImpl,
      credentialDeps: {
        getIntegration: async () => ({ encryptedData: "ENC" }),
        decrypt: () => ({ token: "vc-COMPANY", teamId: "team_co" }),
      },
    });
    await adapter.execute("deploy", { companyId: "co_7", name: "app", gitSource: { repo: "a/b" } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.vercel.com/v13/deployments?teamId=team_co"); // company team
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer vc-COMPANY" });
  });
});
