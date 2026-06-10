import { describe, expect, it } from "vitest";
import { syntaxErrorSummary } from "@/lib/workbench-syntax-gate";

describe("syntaxErrorSummary", () => {
  it("passes valid TSX", async () => {
    const valid = [
      'import { useState } from "react";',
      "export default function App() {",
      "  const [n, setN] = useState(0);",
      "  return <button onClick={() => setN(n + 1)}>Count: {n}</button>;",
      "}",
    ].join("\n");
    expect(await syntaxErrorSummary("src/App.tsx", valid)).toBeUndefined();
  });

  it("catches a stray > in JSX (TS1382 white-screen regression)", async () => {
    const broken = [
      "export default function App() {",
      "  return <div>count => {1}</div>;",
      "}",
    ].join("\n");
    // '=>' inside JSX text is the exact corruption seen in production runs.
    const summary = await syntaxErrorSummary("src/App.tsx", broken);
    expect(summary).toBeDefined();
    expect(summary).toMatch(/\(\d+,\d+\)/);
  });

  it("catches unbalanced braces", async () => {
    const broken = "export function f() { return 1;";
    expect(await syntaxErrorSummary("src/lib/x.ts", broken)).toBeDefined();
  });

  it("validates JSON files", async () => {
    expect(await syntaxErrorSummary("package.json", '{"name":"x"}')).toBeUndefined();
    expect(await syntaxErrorSummary("package.json", '{"name":')).toContain("invalid JSON");
  });

  it("skips non-code files", async () => {
    expect(await syntaxErrorSummary("src/globals.css", "body { color: }")).toBeUndefined();
    expect(await syntaxErrorSummary("README.md", "# hi <<<")).toBeUndefined();
  });
});
