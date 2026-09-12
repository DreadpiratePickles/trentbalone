import { describe, expect, it } from "vitest";
import { landingPageScaffold, queueLaunchApprovals } from "@/lib/operating-cycle-deliverables";
import { store } from "@/lib/store";

describe("landingPageScaffold", () => {
  it("produces a buildable, genuinely interactive landing page", () => {
    const files = landingPageScaffold({ companyName: "Acme", vision: "Book meetings from one message." });
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["package.json", "src/App.tsx", "index.html", "vite.config.ts"]));
    // The CTA must mutate the DOM (anti-Potemkin) — clicking appends a waitlist confirmation.
    expect(files["src/App.tsx"]).toContain("Join the waitlist");
    expect(files["src/App.tsx"]).toContain("on the list");
    expect(files["src/App.tsx"]).toContain("useState");
    // Vision is reflected in the hero headline (escaped).
    expect(files["src/App.tsx"]).toContain("Book meetings from one message");
    // package.json is valid and has the dev/build/test scripts the cloud proof runs.
    const pkg = JSON.parse(files["package.json"]);
    expect(pkg.scripts).toMatchObject({ dev: "vite", build: expect.stringContaining("vite build"), test: "vitest run" });
  });
});

describe("queueLaunchApprovals", () => {
  it("creates exactly 3 correctly-gated launch approvals with extracted ids", async () => {
    const company = await store.createCompany({ name: "Launch Co", brief: { vision: "Ship it." } });
    const approvals = await queueLaunchApprovals({ companyId: company.id, liveUrl: "https://example.test" });

    expect(approvals).toHaveLength(3);
    expect(approvals.every((a) => a.id && a.id.startsWith("approval_"))).toBe(true);
    expect(approvals.map((a) => a.action)).toEqual([
      "publish landing page",
      "send launch email to subscriber list",
      "start launch ad spend",
    ]);

    const pending = (await store.listApprovals(company.id)).filter((a) => a.status === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(3);
  });
});
