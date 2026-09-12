import { describe, expect, it } from "vitest";
import {
  getGbrainConnectionStatus,
  normalizeGbrainConnectionInput,
  saveGbrainConnection,
} from "@/lib/gbrain/gbrain-connections";
import { makeId } from "@/lib/utils";

describe("normalizeGbrainConnectionInput", () => {
  it("requires a companyId", () => {
    expect(() => normalizeGbrainConnectionInput({ baseUrl: "https://gbrain.example" })).toThrow(/companyId/);
  });

  it("rejects a non-http(s) baseUrl", () => {
    expect(() => normalizeGbrainConnectionInput({ companyId: "co_1", baseUrl: "ftp://nope" })).toThrow(/baseUrl/);
  });

  it("accepts a valid https baseUrl and optional apiKey", () => {
    const input = normalizeGbrainConnectionInput({ companyId: "co_1", baseUrl: "https://gbrain.example/", apiKey: "gb_key" });
    expect(input).toEqual({ companyId: "co_1", baseUrl: "https://gbrain.example/", apiKey: "gb_key" });
  });
});

describe("gbrain connection status", () => {
  it("reports needs_credentials when nothing is configured", async () => {
    const status = await getGbrainConnectionStatus(makeId("co"));
    expect(status.status).toBe("needs_credentials");
    expect(status.source).toBe("missing");
  });

  it("saves a company connection and returns a masked status", async () => {
    const companyId = makeId("co");
    await saveGbrainConnection(companyId, { baseUrl: "https://co.gbrain.example", apiKey: "gb_company_secret" });
    const status = await getGbrainConnectionStatus(companyId);
    expect(status.status).toBe("connected");
    expect(status.source).toBe("company");
    expect(status.baseUrl).toBe("https://co.gbrain.example");
    expect(status.apiKey).not.toBe("gb_company_secret");
  });
});
