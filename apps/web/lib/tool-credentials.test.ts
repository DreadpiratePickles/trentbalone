import { describe, expect, it, vi } from "vitest";
import { resolveToolCredential } from "./tool-credentials";

type SlackCred = { botToken: string; defaultChannel?: string };

describe("resolveToolCredential", () => {
  it("uses the env fallback when there is no companyId", async () => {
    const r = await resolveToolCredential<SlackCred>({
      provider: "Slack",
      envFallback: () => ({ botToken: "env-tok" }),
    });
    expect(r).toEqual({ value: { botToken: "env-tok" }, source: "env" });
  });

  it("prefers a per-company encrypted ToolConnection over env (acts under the customer's account)", async () => {
    const getIntegration = vi.fn(async () => ({ encryptedData: "ENC" }));
    const r = await resolveToolCredential<SlackCred>({
      companyId: "co_1",
      provider: "Slack",
      envFallback: () => ({ botToken: "env-tok" }),
      deps: { getIntegration, decrypt: () => ({ botToken: "company-tok", defaultChannel: "#co" }) },
    });
    expect(r.source).toBe("company");
    expect(r.value).toEqual({ botToken: "company-tok", defaultChannel: "#co" });
    expect(getIntegration).toHaveBeenCalledWith("co_1", "Slack");
  });

  it("falls back to env when the company has no connection", async () => {
    const r = await resolveToolCredential<SlackCred>({
      companyId: "co_1",
      provider: "Slack",
      envFallback: () => ({ botToken: "env-tok" }),
      deps: { getIntegration: async () => undefined, decrypt: () => ({}) },
    });
    expect(r).toEqual({ value: { botToken: "env-tok" }, source: "env" });
  });

  it("falls back to env (never crashes) when decryption throws", async () => {
    const r = await resolveToolCredential<SlackCred>({
      companyId: "co_1",
      provider: "Slack",
      envFallback: () => ({ botToken: "env-tok" }),
      deps: {
        getIntegration: async () => ({ encryptedData: "BAD" }),
        decrypt: () => { throw new Error("bad key"); },
      },
    });
    expect(r).toEqual({ value: { botToken: "env-tok" }, source: "env" });
  });

  it("reports 'none' when nothing is configured at either level", async () => {
    const r = await resolveToolCredential<SlackCred>({
      companyId: "co_1",
      provider: "Slack",
      deps: { getIntegration: async () => undefined, decrypt: () => ({}) },
    });
    expect(r).toEqual({ value: undefined, source: "none" });
  });
});
