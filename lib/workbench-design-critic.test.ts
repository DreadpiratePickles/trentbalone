import { describe, expect, it } from "vitest";
import { scoreWorkbenchDesign, designRepairFeedback } from "@/lib/workbench-design-critic";

const PREMIUM_APP = `
export default function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl p-8 md:p-12 space-y-8">
        <h1 className="text-5xl font-bold">Dashboard</h1>
        <button className="bg-primary px-6 py-3 transition-colors duration-200 hover:bg-primary/90 focus-visible:ring-2">
          Action
        </button>
      </div>
    </main>
  );
}
`;

const GENERIC_APP = `
export default function App() {
  return (
    <div style={{ background: "white" }}>
      <h1>Hello</h1>
      <p>Lorem ipsum dolor sit amet.</p>
      <button>Click</button>
    </div>
  );
}
`;

describe("scoreWorkbenchDesign", () => {
  it("passes a polished UI that uses tokens, hierarchy, hover, transitions, responsive", () => {
    const result = scoreWorkbenchDesign({ "src/App.tsx": PREMIUM_APP });
    expect(result.passed).toBe(true);
    expect(result.ratio).toBeGreaterThanOrEqual(0.7);
    expect(result.strengths.length).toBeGreaterThan(3);
  });

  it("fails a generic UI and flags concrete issues incl. lorem ipsum", () => {
    const result = scoreWorkbenchDesign({ "src/App.tsx": GENERIC_APP });
    expect(result.passed).toBe(false);
    expect(result.issues.join(" ")).toMatch(/lorem ipsum/i);
    expect(result.issues.join(" ")).toMatch(/theme tokens/i);
  });

  it("reports nothing to evaluate when there is no UI source", () => {
    const result = scoreWorkbenchDesign({ "src/server.ts": "export const x = 1;" });
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toMatch(/No UI source/);
  });

  it("produces actionable repair feedback only when below bar", () => {
    expect(designRepairFeedback(scoreWorkbenchDesign({ "src/App.tsx": PREMIUM_APP }))).toBe("");
    const repair = designRepairFeedback(scoreWorkbenchDesign({ "src/App.tsx": GENERIC_APP }));
    expect(repair).toMatch(/below bar/);
    expect(repair).toMatch(/- /);
  });
});
