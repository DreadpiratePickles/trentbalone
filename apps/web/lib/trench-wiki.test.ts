import { describe, expect, it } from "vitest";
import type { Document, WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import {
  buildArchitectureDiagram,
  buildIndexFreshnessTelemetry,
  buildTrenchWikiIndex,
  buildWikiPageSummary,
  chunkWikiSource,
  diffWikiVersions,
  isIndexableWikiPath,
  shouldReindexFromWorkbenchEvent,
} from "@/lib/trench-wiki";

const session = {
  id: "ws_1",
  companyId: "co_1",
  agentRole: "engineer",
  agentMode: "build",
  messageCount: 0,
  status: "completed",
  provider: "mock_local",
  objective: "Build billing API",
  repoUrl: "https://github.com/acme/app",
  workdir: "/workspace/app",
  costCents: 125,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:05:00.000Z",
  metadata: {
    networkPolicy: "allowlist",
    allowedHosts: ["github.com"],
    maxRuntimeSeconds: 3600,
    maxCostCents: 2000,
    approvalRequiredFor: ["deploy"],
    rollbackAvailable: true,
  },
} satisfies WorkbenchSession;

const fileEvent = {
  id: "evt_1",
  companyId: "co_1",
  sessionId: "ws_1",
  type: "file",
  status: "completed",
  title: "Updated billing route",
  content: "Edited app/api/billing/route.ts lines 12-44 to add idempotency.",
  command: "apply_patch app/api/billing/route.ts",
  createdAt: "2026-05-29T00:03:00.000Z",
} satisfies WorkbenchEvent;

const deployEvent = {
  ...fileEvent,
  id: "evt_2",
  type: "deploy",
  title: "Deploy preview",
  content: "Preview deployed for branch billing.",
  createdAt: "2026-05-29T00:04:00.000Z",
} satisfies WorkbenchEvent;

const artifact = {
  id: "art_1",
  companyId: "co_1",
  sessionId: "ws_1",
  kind: "file",
  title: "app/api/billing/route.ts",
  storageKey: "workspace/app/api/billing/route.ts",
  mimeType: "text/typescript",
  sizeBytes: 900,
  createdAt: "2026-05-29T00:03:30.000Z",
} satisfies WorkbenchArtifact;

const memoryDoc = {
  id: "doc_1",
  companyId: "co_1",
  type: "agent_note",
  title: "Billing architecture decision",
  content: "Billing writes must be idempotent and audited before payment capture.",
  source: "cycle:phase5",
  version: 1,
  memoryTier: "semantic",
  createdAt: "2026-05-29T00:01:00.000Z",
} satisfies Document;

describe("Trench Wiki domain", () => {
  it("filters unsafe workspace paths out of the index", () => {
    expect(isIndexableWikiPath("app/api/billing/route.ts")).toBe(true);
    expect(isIndexableWikiPath("lib/workbench.ts")).toBe(true);
    expect(isIndexableWikiPath(".env")).toBe(false);
    expect(isIndexableWikiPath("secrets/private.pem")).toBe(false);
    expect(isIndexableWikiPath("node_modules/react/index.js")).toBe(false);
  });

  it("chunks source content with stable line ranges and file citations", () => {
    const chunks = chunkWikiSource({
      id: "src_1",
      kind: "file",
      title: "Billing route",
      path: "app/api/billing/route.ts",
      content: "line one\nline two\nline three\nline four",
      createdAt: "2026-05-29T00:00:00.000Z",
    }, 18);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({
      sourceId: "src_1",
      path: "app/api/billing/route.ts",
      startLine: 1,
      endLine: 2,
    });
    expect(chunks[0]?.citation).toBe("app/api/billing/route.ts:1");
  });

  it("builds page summaries with source links back to files and lines", () => {
    const page = buildWikiPageSummary({
      id: "src_1",
      kind: "file",
      title: "Billing route",
      path: "app/api/billing/route.ts",
      content: "export async function POST() {}\nwithRlsContext(companyId, runBilling)",
      createdAt: "2026-05-29T00:00:00.000Z",
    });

    expect(page.slug).toBe("app-api-billing-route-ts");
    expect(page.summary).toContain("POST");
    expect(page.sourceLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "app/api/billing/route.ts", line: 1 }),
      expect.objectContaining({ path: "app/api/billing/route.ts", line: 2 }),
    ]));
  });

  it("creates a mermaid architecture diagram from indexed source paths", () => {
    const diagram = buildArchitectureDiagram([
      { id: "a", kind: "file", title: "API", path: "app/api/billing/route.ts", content: "route", createdAt: "2026-05-29T00:00:00.000Z" },
      { id: "b", kind: "file", title: "Provider", path: "lib/payments/stripe.ts", content: "stripe", createdAt: "2026-05-29T00:00:00.000Z" },
      { id: "c", kind: "memory", title: "Decision", path: "memory/decision.md", content: "audited", createdAt: "2026-05-29T00:00:00.000Z" },
    ]);

    expect(diagram.kind).toBe("mermaid");
    expect(diagram.content).toContain("graph TD");
    expect(diagram.content).toContain("app_api");
    expect(diagram.content).toContain("lib");
    expect(diagram.content).toContain("memory");
  });

  it("detects Workbench events that should trigger incremental re-indexing", () => {
    expect(shouldReindexFromWorkbenchEvent(fileEvent)).toBe(true);
    expect(shouldReindexFromWorkbenchEvent(deployEvent)).toBe(true);
    expect(shouldReindexFromWorkbenchEvent({ ...fileEvent, type: "plan" })).toBe(false);
    expect(shouldReindexFromWorkbenchEvent({ ...fileEvent, status: "failed" })).toBe(false);
  });

  it("diffs wiki versions by page slug", () => {
    const diff = diffWikiVersions(
      [{ slug: "billing", title: "Billing", checksum: "old" }, { slug: "search", title: "Search", checksum: "same" }],
      [{ slug: "billing", title: "Billing", checksum: "new" }, { slug: "wiki", title: "Wiki", checksum: "fresh" }, { slug: "search", title: "Search", checksum: "same" }]
    );

    expect(diff.added).toEqual(["wiki"]);
    expect(diff.changed).toEqual(["billing"]);
    expect(diff.removed).toEqual([]);
  });

  it("surfaces freshness and cost telemetry for budgets", () => {
    const freshness = buildIndexFreshnessTelemetry({
      generatedAt: "2026-05-29T00:10:00.000Z",
      latestSourceAt: "2026-05-29T00:04:00.000Z",
      sourceCount: 4,
      chunkCount: 8,
      usageCents: 125,
      budgetCents: 1000,
    });

    expect(freshness.ageSeconds).toBe(360);
    expect(freshness.isStale).toBe(false);
    expect(freshness.costTelemetry).toMatchObject({ usageCents: 125, budgetCents: 1000, remainingCents: 875 });
  });

  it("builds a browsable index from sessions, events, artifacts, memory, and prior index snapshots", () => {
    const previousIndex = {
      pages: [{ slug: "old", title: "Old", checksum: "gone" }],
      generatedAt: "2026-05-28T00:00:00.000Z",
    };
    const priorIndexDoc = {
      ...memoryDoc,
      id: "doc_index",
      title: "Trench Wiki Index",
      source: "trench_wiki_indexer",
      content: JSON.stringify(previousIndex),
      createdAt: "2026-05-28T00:00:00.000Z",
    } satisfies Document;

    const index = buildTrenchWikiIndex({
      companyId: "co_1",
      sessions: [session],
      events: [fileEvent, deployEvent],
      artifacts: [artifact],
      documents: [memoryDoc, priorIndexDoc],
      usageCents: 125,
      budgetCents: 1000,
      generatedAt: "2026-05-29T00:10:00.000Z",
    });

    expect(index.tree.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(["Workbench", "Artifacts", "Memory"]));
    expect(index.pages.some((page) => page.sourceLinks.some((link) => link.path.includes("app/api/billing/route.ts")))).toBe(true);
    expect(index.diagrams[0]?.content).toContain("graph TD");
    expect(index.versions.previousGeneratedAt).toBe("2026-05-28T00:00:00.000Z");
    expect(index.versions.diff.removed).toContain("old");
    expect(index.freshness.costTelemetry.remainingCents).toBe(875);
  });
});
