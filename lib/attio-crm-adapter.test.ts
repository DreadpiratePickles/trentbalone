import { describe, expect, it, vi } from "vitest";
import { createAttioCrmAdapter } from "@/lib/attio-crm-adapter";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Attio CRM adapter", () => {
  it("reports needs_credentials without an Attio token", async () => {
    const adapter = createAttioCrmAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    await expect(adapter.execute("read pipeline", {})).resolves.toMatchObject({
      adapter: "Attio CRM",
      status: "failed",
    });
  });

  it("reads objects and selected records without leaking credentials", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [
          { api_slug: "people", singular_noun: "Person", plural_noun: "People" },
          { api_slug: "companies", singular_noun: "Company", plural_noun: "Companies" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [
          {
            id: { record_id: "rec_1" },
            values: {
              name: [{ value: "North Star Foods" }],
              email_addresses: [{ value: "ops@example.com" }],
            },
          },
          {
            id: { record_id: "rec_2" },
            values: {
              name: [{ value: "Second Account" }],
            },
          },
        ],
      }));
    const adapter = createAttioCrmAdapter({
      env: { ATTIO_TOKEN: "attio_secret_token" },
      fetchImpl,
    });

    await expect(adapter.healthCheck()).resolves.toBe("connected");
    const result = await adapter.execute("read people records", { object: "people", limit: 2 });

    expect(result).toMatchObject({
      adapter: "Attio CRM",
      action: "read people records",
      status: "completed",
    });
    expect(result.summary).toContain("2 Attio objects available");
    expect(result.summary).toContain("people: 2 record");
    expect(result.summary).toContain("North Star Foods");
    expect(result.summary).not.toContain("attio_secret_token");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.attio.com/v2/objects", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer attio_secret_token" }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.attio.com/v2/objects/people/records/query", expect.objectContaining({
      method: "POST",
    }));
  });

  it("blocks write actions in the sales seat tool path", async () => {
    const adapter = createAttioCrmAdapter({
      env: { ATTIO_TOKEN: "attio_secret_token" },
      fetchImpl: vi.fn(),
    });

    expect(adapter.requiresApproval("update deal stage")).toBe(true);
    await expect(adapter.dryRun?.("update deal stage", {})).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(adapter.execute("update deal stage", {})).resolves.toMatchObject({
      status: "failed",
      summary: expect.stringContaining("read-only"),
    });
  });
});
