import { describe, expect, it } from "vitest";
import {
  setVisualProfile,
  getVisualProfile,
  getVisualContext,
  type BrandVisualProfile,
} from "@/lib/brand/visual-memory";
import { store } from "@/lib/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany() {
  return store.createCompany({
    name: `VisualMemory-${Date.now()}-${Math.random()}`,
    budgetCents: 10_000,
    brief: { vision: "visual memory tests" },
  });
}

const FULL_PROFILE: Omit<BrandVisualProfile, "updatedAt"> = {
  logoUrl:            "https://trent-acme.r2.dev/brand/logo.png",
  palette:            ["#1A2B3C", "#FFFFFF", "#F5A623"],
  typography:         ["Inter", "Playfair Display"],
  referenceImageUrls: ["https://trent-acme.r2.dev/brand/ref1.jpg"],
  negativeTerms:      ["dark", "grungy", "amateur", "low-quality"],
};

const MINIMAL_PROFILE: Omit<BrandVisualProfile, "updatedAt"> = {
  palette:            [],
  typography:         [],
  referenceImageUrls: [],
  negativeTerms:      [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("visual-memory", () => {
  // ── setVisualProfile / getVisualProfile ────────────────────────────────────

  describe("setVisualProfile", () => {
    it("stores a profile that is retrievable via getVisualProfile", async () => {
      const company = await makeCompany();

      await setVisualProfile(company.id, FULL_PROFILE);

      const loaded = await getVisualProfile(company.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.palette).toEqual(["#1A2B3C", "#FFFFFF", "#F5A623"]);
      expect(loaded!.typography).toEqual(["Inter", "Playfair Display"]);
      expect(loaded!.logoUrl).toBe("https://trent-acme.r2.dev/brand/logo.png");
      expect(loaded!.negativeTerms).toEqual(["dark", "grungy", "amateur", "low-quality"]);
    });

    it("records an updatedAt ISO timestamp on save", async () => {
      const company = await makeCompany();
      const before  = Date.now();

      const profile = await setVisualProfile(company.id, FULL_PROFILE);

      expect(profile.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(new Date(profile.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
    });

    it("overwrites an existing profile — latest wins (full replace)", async () => {
      const company = await makeCompany();

      await setVisualProfile(company.id, FULL_PROFILE);
      await setVisualProfile(company.id, {
        ...FULL_PROFILE,
        palette: ["#000000", "#FF0000"],
      });

      const loaded = await getVisualProfile(company.id);
      expect(loaded!.palette).toEqual(["#000000", "#FF0000"]);
    });

    it("profiles are company-isolated — company A's profile is not visible to company B", async () => {
      const companyA = await makeCompany();
      const companyB = await makeCompany();

      await setVisualProfile(companyA.id, FULL_PROFILE);

      const profileB = await getVisualProfile(companyB.id);
      expect(profileB).toBeNull();
    });
  });

  describe("getVisualProfile", () => {
    it("returns null when no profile has been set for the company", async () => {
      const company = await makeCompany();
      expect(await getVisualProfile(company.id)).toBeNull();
    });
  });

  // ── getVisualContext ───────────────────────────────────────────────────────

  describe("getVisualContext", () => {
    it("positivePrompt contains all palette hex codes", () => {
      const profile: BrandVisualProfile = { ...FULL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { positivePrompt } = getVisualContext(profile);

      expect(positivePrompt).toContain("#1A2B3C");
      expect(positivePrompt).toContain("#FFFFFF");
      expect(positivePrompt).toContain("#F5A623");
    });

    it("positivePrompt contains typography names", () => {
      const profile: BrandVisualProfile = { ...FULL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { positivePrompt } = getVisualContext(profile);

      expect(positivePrompt).toContain("Inter");
      expect(positivePrompt).toContain("Playfair Display");
    });

    it("positivePrompt references logo when logoUrl is set", () => {
      const profile: BrandVisualProfile = { ...FULL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { positivePrompt } = getVisualContext(profile);

      expect(positivePrompt).toBeTruthy();
      // Logo presence implies a branding instruction in the prompt
      expect(positivePrompt!.toLowerCase()).toMatch(/logo|brand/);
    });

    it("negativePrompt contains all negativeTerms", () => {
      const profile: BrandVisualProfile = { ...FULL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { negativePrompt } = getVisualContext(profile);

      expect(negativePrompt).toContain("dark");
      expect(negativePrompt).toContain("grungy");
      expect(negativePrompt).toContain("amateur");
    });

    it("omits positivePrompt when palette, typography, logo, and references are all empty", () => {
      const profile: BrandVisualProfile = { ...MINIMAL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { positivePrompt } = getVisualContext(profile);

      expect(positivePrompt).toBeUndefined();
    });

    it("omits negativePrompt when negativeTerms is empty", () => {
      const profile: BrandVisualProfile = { ...MINIMAL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const { negativePrompt } = getVisualContext(profile);

      expect(negativePrompt).toBeUndefined();
    });

    it("returns positivePrompt only when palette is set but negativeTerms is empty", () => {
      const profile: BrandVisualProfile = {
        ...MINIMAL_PROFILE,
        palette:    ["#123456"],
        updatedAt:  "2026-01-01T00:00:00Z",
      };
      const ctx = getVisualContext(profile);

      expect(ctx.positivePrompt).toBeTruthy();
      expect(ctx.negativePrompt).toBeUndefined();
    });

    it("is a pure function — same profile always produces the same output", () => {
      const profile: BrandVisualProfile = { ...FULL_PROFILE, updatedAt: "2026-01-01T00:00:00Z" };
      const a = getVisualContext(profile);
      const b = getVisualContext(profile);

      expect(a.positivePrompt).toBe(b.positivePrompt);
      expect(a.negativePrompt).toBe(b.negativePrompt);
    });

    it("referenceImageUrls presence adds a style-reference note to positivePrompt", () => {
      const profile: BrandVisualProfile = {
        ...MINIMAL_PROFILE,
        referenceImageUrls: ["https://r2.dev/ref.jpg"],
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const { positivePrompt } = getVisualContext(profile);

      expect(positivePrompt).toBeTruthy();
      expect(positivePrompt!.toLowerCase()).toMatch(/reference|style|brand/);
    });
  });
});
