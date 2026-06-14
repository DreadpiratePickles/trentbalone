import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrustPanel } from "@/components/trust-panel";
import { buildTrustPanel } from "@/lib/trust-panel";
import type { SeatToolContract } from "@/lib/seat-tool-contracts";

const contracts: SeatToolContract[] = [
  { seat: "growth", tool: "Stripe", binding: null, resolvedAdapter: "Stripe", readiness: "connected", advertised: true, approvalRequired: false, writeCapable: false },
  { seat: "growth", tool: "Resend", binding: null, resolvedAdapter: "Resend", readiness: "needs_credentials", advertised: true, approvalRequired: true, writeCapable: true },
];

describe("TrustPanel component", () => {
  it("renders per-action provenance badges and the no-unverified-claims badge", () => {
    const panel = buildTrustPanel({ contracts, toolCalls: [], output: { summary: "Drafted a plan." } });
    const html = renderToStaticMarkup(<TrustPanel panel={panel} />);

    expect(html).toContain('data-testid="trust-panel"');
    expect(html).toContain('data-testid="no-unverified-claims-badge"');
    expect(html).toContain("No unverified claims");
    expect(html).toContain('data-provenance="connected"');
    expect(html).toContain('data-provenance="needs_credentials"');
    expect(html).toContain("Resend");
  });

  it("renders a blocked-claims badge and the offending violation when prose makes a false claim", () => {
    const panel = buildTrustPanel({
      contracts,
      toolCalls: [],
      output: { summary: "I sent every signup their onboarding email." },
    });
    const html = renderToStaticMarkup(<TrustPanel panel={panel} />);

    expect(html).toContain('data-testid="blocked-claims-badge"');
    expect(html).toContain("unverified claim");
    expect(html).toContain('data-testid="trust-violations"');
    expect(html).not.toContain('data-testid="no-unverified-claims-badge"');
  });
});
