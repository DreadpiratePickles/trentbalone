import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

async function headerMap() {
  const headers = await nextConfig.headers?.();
  const global = headers?.find((entry) => entry.source === "/:path*");
  return new Map(global?.headers.map((header) => [header.key, header.value]) ?? []);
}

describe("Next.js security headers", () => {
  it("sends baseline browser hardening headers globally", async () => {
    const headers = await headerMap();

    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("keeps a restrictive CSP baseline", async () => {
    const csp = (await headerMap()).get("Content-Security-Policy") ?? "";

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });
});
