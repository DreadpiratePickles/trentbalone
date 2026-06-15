import { describe, expect, it } from "vitest";
import { saveGitHubConnection } from "@/lib/github";
import { adapters, integrationHealth } from "@/lib/tools";
import { store } from "@/lib/store";
import { createResendEmailAdapter } from "@/lib/resend-email-adapter";
import { createStripeReadAdapter } from "@/lib/stripe-read-adapter";
import { createSentryReadAdapter } from "@/lib/sentry-read-adapter";
import { createPostHogReadAdapter } from "@/lib/posthog-read-adapter";
import { createXSocialAdapter } from "@/lib/x-social-adapter";
import { createAttioCrmAdapter } from "@/lib/attio-crm-adapter";

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

  it("does not expose removed fake finance sandbox apps", () => {
    expect(adapters.map((adapter) => adapter.name)).not.toEqual(expect.arrayContaining([
      "Fincept Terminal",
      "Ghostfolio",
    ]));
    expect(adapters.flatMap((adapter) => adapter.scopes)).not.toEqual(expect.arrayContaining([
      "fincept:launch_sandbox",
      "ghostfolio:launch_sandbox",
    ]));
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

  it("registers Email as a real Resend-backed adapter instead of a mocked send path", async () => {
    const email = adapters.find((adapter) => adapter.name === "Email");

    expect(email?.scopes).toContain("resend:email:send");
    expect(email?.availability).not.toBe("test_only");
    expect(email?.requiresApproval("send morning founder email")).toBe(true);

    const result = await email?.dryRun?.("send", {
      to: "founder@example.com",
      subject: "Morning brief",
      text: "Here is the update.",
    });
    expect(result?.summary).not.toMatch(/mocked/i);
  });

  it("keeps implemented-but-uncredentialed adapters real with needs_credentials health", async () => {
    const emptyEnvAdapters = [
      createResendEmailAdapter({ env: {} }),
      createStripeReadAdapter({ env: {} }),
      createSentryReadAdapter({ env: {} }),
      createPostHogReadAdapter({ env: {} }),
      createXSocialAdapter({ env: {} }),
      createAttioCrmAdapter({ env: {} }),
    ];

    for (const adapter of emptyEnvAdapters) {
      const registered = adapters.find((item) => item.name === adapter.name);

      expect(registered?.availability, `${adapter.name} should be a real adapter in the global registry`).toBe("real");
      expect(adapter.availability, `${adapter.name} should be implemented even before credentials are configured`).toBe("real");
      expect(await adapter.healthCheck(), `${adapter.name} should ask for credentials instead of disappearing`).toBe("needs_credentials");
    }
  });

  it("registers Sentry as a real read-only adapter instead of mocked diagnostics", async () => {
    const sentry = adapters.find((adapter) => adapter.name === "Sentry");

    expect(sentry?.scopes).toContain("sentry:issues:read");
    expect(sentry?.availability).not.toBe("test_only");
    expect(sentry?.requiresApproval("read unresolved issues")).toBe(false);
    expect(sentry?.requiresApproval("resolve issue")).toBe(true);
  });

  it("registers PostHog as a real read-only analytics adapter", async () => {
    const posthog = adapters.find((adapter) => adapter.name === "PostHog");

    expect(posthog?.scopes).toContain("analytics:read");
    expect(posthog?.availability).not.toBe("test_only");
    expect(posthog?.requiresApproval("read metrics")).toBe(false);
    expect(posthog?.requiresApproval("delete event")).toBe(true);
  });

  it("registers X as the first real social publishing adapter and keeps Late.dev unavailable", async () => {
    const x = adapters.find((adapter) => adapter.name === "X");
    const late = adapters.find((adapter) => adapter.name === "Late.dev");

    expect(x?.scopes).toContain("social:publish");
    expect(x?.availability).not.toBe("test_only");
    expect(x?.requiresApproval("publish post")).toBe(true);
    expect(late?.availability).toBe("unavailable");
  });

  it("registers Attio CRM as a real read-only sales adapter", async () => {
    const attio = adapters.find((adapter) => adapter.name === "Attio CRM");

    expect(attio?.scopes).toContain("crm:read");
    expect(attio?.availability).toBe("real");
    expect(attio?.requiresApproval("read pipeline")).toBe(false);
    expect(attio?.requiresApproval("update opportunity")).toBe(true);
  });

  it("does not expose Postmark as a mocked production-capable adapter", async () => {
    const postmark = adapters.find((adapter) => adapter.name === "Postmark");

    expect(postmark?.availability).toBe("unavailable");
    const result = await postmark?.execute("send", { to: "founder@example.com" });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toContain("not configured");
  });
});
