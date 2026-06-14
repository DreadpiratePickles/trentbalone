import { describe, it, expect } from "vitest";
import {
  extractExports,
  buildSymbolMap,
  buildReferenceGraph,
  rankFiles,
  renderRepoMap,
  estimateTokens,
  type RepoFile,
} from "@/lib/workbench-repo-map";

const FIXTURE: RepoFile[] = [
  {
    path: "src/App.tsx",
    content: [
      'import { Button } from "./components/Button";',
      'import { formatDate } from "./lib/format";',
      "export default function App() {",
      "  return <Button>{formatDate(new Date())}</Button>;",
      "}",
    ].join("\n"),
  },
  {
    path: "src/components/Button.tsx",
    content: [
      "export function Button(props: { children: unknown }) {",
      "  return props.children;",
      "}",
    ].join("\n"),
  },
  {
    path: "src/lib/format.ts",
    content: [
      "export const formatDate = (d: Date) => d.toISOString();",
      "export function formatTime(d: Date) { return d.toTimeString(); }",
    ].join("\n"),
  },
  {
    path: "src/lib/unused.ts",
    content: "export function neverUsed() { return 42; }",
  },
];

describe("extractExports", () => {
  it("captures function, const, class, type, interface and default exports", () => {
    const content = [
      "export function foo() {}",
      "export const bar = 1;",
      "export class Baz {}",
      "export type Qux = string;",
      "export interface Quux { a: number }",
      "export default function App() {}",
    ].join("\n");
    const syms = extractExports(content);
    expect(syms).toContain("foo");
    expect(syms).toContain("bar");
    expect(syms).toContain("Baz");
    expect(syms).toContain("Qux");
    expect(syms).toContain("Quux");
    expect(syms).toContain("default");
  });

  it("does not invent exports for a file with none", () => {
    expect(extractExports("const local = 1;\nfunction helper() {}\n")).toEqual([]);
  });
});

describe("buildSymbolMap", () => {
  it("maps each file path to its exported symbols", () => {
    const map = buildSymbolMap(FIXTURE);
    expect(map["src/lib/format.ts"]).toEqual(["formatDate", "formatTime"]);
    expect(map["src/components/Button.tsx"]).toEqual(["Button"]);
  });
});

describe("buildReferenceGraph", () => {
  it("resolves relative imports to in-repo file paths", () => {
    const graph = buildReferenceGraph(FIXTURE);
    expect(graph["src/App.tsx"]).toEqual(
      expect.arrayContaining(["src/components/Button.tsx", "src/lib/format.ts"]),
    );
    // a leaf util imports nothing in-repo
    expect(graph["src/lib/format.ts"]).toEqual([]);
  });
});

describe("rankFiles (PageRank)", () => {
  it("ranks a referenced util above an unreferenced one", () => {
    const ranked = rankFiles(FIXTURE);
    expect(ranked.indexOf("src/lib/format.ts")).toBeLessThan(
      ranked.indexOf("src/lib/unused.ts"),
    );
  });

  it("biases ranking toward files related to the seed set", () => {
    const ranked = rankFiles(FIXTURE, { seeds: ["src/App.tsx"] });
    // Button + format are reachable from the seed; unused is not.
    expect(ranked.indexOf("src/lib/format.ts")).toBeLessThan(
      ranked.indexOf("src/lib/unused.ts"),
    );
  });
});

describe("renderRepoMap", () => {
  it("renders a skeleton of path → symbols", () => {
    const out = renderRepoMap(FIXTURE);
    expect(out).toContain("src/lib/format.ts");
    expect(out).toContain("formatDate");
  });

  it("stays within the token budget, keeping highest-ranked files", () => {
    const budget = 28;
    const out = renderRepoMap(FIXTURE, { tokenBudget: budget });
    expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
    // the most-referenced file survives truncation
    expect(out).toContain("src/lib/format.ts");
    // the unreferenced file is dropped first
    expect(out).not.toContain("src/lib/unused.ts");
  });
});
