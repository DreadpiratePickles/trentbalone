import { describe, expect, it } from "vitest";
import { saveGitHubConnection } from "@/lib/github";
import { adapters, integrationHealth } from "@/lib/tools";
import { store } from "@/lib/store";

describe("integration health", () => {
  it("declares availability for every registered adapter", () => {
    for (const adapter of adapters) {
      expect(["real", "unavailable", "test_only"]).toContain(adapter.availability);
    }
  });

  it("uses company-scoped GitHub credentials", async () => {
    const company = await store.createCompany({
      name: "Integration Health Co",
      brief: { vision: "Check connected tools" }
    });
    await saveGitHubConnection(company.id, {
      token: "ghp_company_scoped_token",
      owner: "trent",
      repo: "backend"
    });

    const health = await integrationHealth(company.id);
    expect(health.find((item) => item.name === "GitHub")?.status).toBe("connected");
  });

  it("declares Steel as the primary browser adapter for web access", async () => {
    const steel = adapters.find((adapter) => adapter.name === "Steel Browser");
    expect(steel?.scopes).toEqual([
      "steel:scrape",
      "steel:screenshot",
      "steel:pdf",
      "steel:sessions",
    ]);
    expect(steel?.requiresApproval("login to LinkedIn")).toBe(true);
    expect(steel?.requiresApproval("screenshot public docs")).toBe(false);

    const health = await integrationHealth();
    expect(health.find((item) => item.name === "Steel Browser")?.estimatedCostCents).toBe(1);
  });

  it("keeps Camofox as a fallback browser automation adapter", async () => {
    const camofox = adapters.find((adapter) => adapter.name === "Camofox");
    expect(camofox?.scopes).toEqual([
      "camofox:tab",
      "camofox:navigate",
      "camofox:snapshot",
      "camofox:click",
      "camofox:type",
      "camofox:scroll",
      "camofox:screenshot",
      "camofox:close",
    ]);
    expect(camofox?.requiresApproval("login to LinkedIn")).toBe(true);
    expect(camofox?.requiresApproval("snapshot public docs")).toBe(false);

    const health = await integrationHealth();
    expect(health.find((item) => item.name === "Camofox")?.estimatedCostCents).toBe(0);
  });

  it("declares HyperFrames as a safe-by-default growth video creation adapter", async () => {
    const hyperframes = adapters.find((adapter) => adapter.name === "HyperFrames");

    expect(hyperframes?.scopes).toEqual([
      "hyperframes:create",
      "hyperframes:catalog",
      "hyperframes:preview",
      "hyperframes:lint",
      "hyperframes:inspect",
      "hyperframes:render",
    ]);
    expect(hyperframes?.requiresApproval("publish video")).toBe(true);
    expect(hyperframes?.requiresApproval("render draft")).toBe(false);

    const result = await hyperframes?.execute("render", { output: "renders/final.mp4", quality: "draft" });
    expect(result?.status).toBe("mocked");
    expect(result?.summary).toContain("npx hyperframes render");
  });

  it("declares Claude Ads as a critic-only paid media audit adapter", async () => {
    const claudeAds = adapters.find((adapter) => adapter.name === "Claude Ads");

    expect(claudeAds?.scopes).toEqual([
      "claude_ads:audit",
      "claude_ads:platform_review",
      "claude_ads:creative_review",
      "claude_ads:budget_review",
      "claude_ads:landing_review",
      "claude_ads:report",
    ]);
    expect(claudeAds?.requiresApproval("audit meta ads")).toBe(false);
    expect(claudeAds?.requiresApproval("launch campaign")).toBe(true);

    const result = await claudeAds?.execute("creative fatigue review", { platform: "meta" });
    expect(result?.status).toBe("mocked");
    expect(result?.summary).toContain("/ads meta");
  });

  it("declares Fincept Terminal as a sandbox-only finance adapter", async () => {
    const fincept = adapters.find((adapter) => adapter.name === "Fincept Terminal");

    expect(fincept?.scopes).toEqual([
      "fincept:launch_sandbox",
      "fincept:market_research",
      "fincept:portfolio_analysis",
      "fincept:risk_report",
      "fincept:economic_data",
      "fincept:paper_trading",
    ]);
    expect(fincept?.requiresApproval("portfolio risk report")).toBe(false);
    expect(fincept?.requiresApproval("connect broker")).toBe(true);
    expect(fincept?.requiresApproval("live trade")).toBe(true);

    const result = await fincept?.execute("risk_report", { ticker: "NVDA" });
    expect(result?.status).toBe("mocked");
    expect(result?.summary).toContain("Fincept Terminal sandbox plan");
  });

  it("declares Ghostfolio as a sandbox-only finance wealth adapter", async () => {
    const ghostfolio = adapters.find((adapter) => adapter.name === "Ghostfolio");

    expect(ghostfolio?.scopes).toEqual([
      "ghostfolio:launch_sandbox",
      "ghostfolio:portfolio_overview",
      "ghostfolio:holdings_import",
      "ghostfolio:allocation_report",
      "ghostfolio:performance_report",
      "ghostfolio:risk_insights",
      "ghostfolio:fire_projection",
    ]);
    expect(ghostfolio?.requiresApproval("portfolio overview")).toBe(false);
    expect(ghostfolio?.requiresApproval("connect broker")).toBe(true);
    expect(ghostfolio?.requiresApproval("live account sync")).toBe(true);

    const result = await ghostfolio?.execute("allocation_report", { portfolio: "client-model" });
    expect(result?.status).toBe("mocked");
    expect(result?.summary).toContain("Ghostfolio sandbox plan");
  });

  it("declares Open Generative AI as a safe-by-default growth creative adapter", async () => {
    const openGen = adapters.find((adapter) => adapter.name === "Open Generative AI");

    expect(openGen?.scopes).toEqual([
      "open_gen_ai:launch_sandbox",
      "open_gen_ai:image_generate",
      "open_gen_ai:video_generate",
      "open_gen_ai:lip_sync",
      "open_gen_ai:cinema_workflow",
      "open_gen_ai:asset_export",
    ]);
    expect(openGen?.requiresApproval("generate image")).toBe(false);
    expect(openGen?.requiresApproval("publish to social")).toBe(true);
    expect(openGen?.requiresApproval("launch ad")).toBe(true);

    const result = await openGen?.execute("video_generate", { prompt: "product launch teaser" });
    expect(result?.status).toBe("mocked");
    expect(result?.summary).toContain("Open Generative AI sandbox plan");
  });
});
