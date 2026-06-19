import { describe, expect, it } from "vitest";
import { validateMcpServerTarget } from "@/lib/mcp-transport";

describe("MCP transport firewall", () => {
  it("rejects loopback and private network HTTP targets", () => {
    expect(validateMcpServerTarget({ url: "http://localhost:3000/mcp", transport: "http" }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/private|loopback/i) });
    expect(validateMcpServerTarget({ url: "http://127.0.0.1:3000/mcp", transport: "http" }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/private|loopback/i) });
    expect(validateMcpServerTarget({ url: "https://10.0.0.5/mcp", transport: "http" }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/private|loopback/i) });
  });

  it("keeps public HTTPS and approved stdio presets available", () => {
    expect(validateMcpServerTarget({ url: "https://mcp.stripe.com", transport: "http" }))
      .toMatchObject({ ok: true, url: "https://mcp.stripe.com" });
    expect(validateMcpServerTarget({ url: "stdio://sentry", transport: "stdio" }))
      .toMatchObject({ ok: true, url: "stdio://sentry", transport: "stdio" });
  });
});
