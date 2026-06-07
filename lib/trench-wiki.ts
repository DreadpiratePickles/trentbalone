import { createHash } from "crypto";
import type { Document, UsageLedgerEntry, WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

export type WikiSourceKind = "file" | "artifact" | "memory" | "session" | "event";

export type WikiSource = {
  id: string;
  kind: WikiSourceKind;
  title: string;
  path: string;
  content: string;
  createdAt: string;
};

export type WikiSourceLink = {
  path: string;
  line: number;
  label: string;
};

export type WikiPage = {
  slug: string;
  title: string;
  summary: string;
  sourceId: string;
  sourceKind: WikiSourceKind;
  sourceLinks: WikiSourceLink[];
  checksum: string;
  updatedAt: string;
};

export type WikiIndex = {
  companyId: string;
  generatedAt: string;
  tree: { nodes: Array<{ id: string; label: string; count: number }> };
  pages: WikiPage[];
  diagrams: Array<{ id: string; kind: "mermaid"; title: string; content: string; generatedAt: string }>;
  versions: {
    previousGeneratedAt?: string;
    diff: { added: string[]; changed: string[]; removed: string[] };
  };
  freshness: {
    generatedAt: string;
    latestSourceAt?: string;
    ageSeconds: number;
    isStale: boolean;
    sourceCount: number;
    chunkCount: number;
    costTelemetry: { usageCents: number; budgetCents: number; remainingCents: number };
  };
};

type PriorPage = Pick<WikiPage, "slug" | "title" | "checksum">;

const BLOCKED_PATH_PARTS = [
  ".env",
  "node_modules/",
  ".git/",
  ".next/",
  "private.pem",
  ".pem",
  ".key",
  "id_rsa",
  "secrets/",
];

export function isIndexableWikiPath(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (!normalized.trim()) return false;
  return !BLOCKED_PATH_PARTS.some((part) => normalized === part || normalized.includes(part));
}

export function chunkWikiSource(source: WikiSource, maxChars = 1200) {
  const lines = source.content.split(/\r?\n/);
  const chunks: Array<WikiSource & { sourceId: string; startLine: number; endLine: number; citation: string }> = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (endLine: number) => {
    if (current.length === 0) return;
    chunks.push({
      ...source,
      id: `${source.id}:${startLine}`,
      sourceId: source.id,
      content: current.join("\n"),
      startLine,
      endLine,
      citation: `${source.path}:${startLine}`,
    });
    current = [];
    startLine = endLine + 1;
  };

  lines.forEach((line, index) => {
    const nextContent = [...current, line].join("\n");
    if (current.length > 0 && nextContent.length > maxChars) {
      flush(index);
    }
    current.push(line);
  });
  flush(lines.length);

  return chunks;
}

export function buildWikiPageSummary(source: WikiSource): WikiPage {
  const lines = source.content.split(/\r?\n/);
  const meaningful = lines.map((line) => line.trim()).filter(Boolean);
  const summary = meaningful.slice(0, 3).join(" ").slice(0, 320) || `${source.title} has no textual summary yet.`;
  const linkedLines = meaningful.length === 0 ? [1] : lines
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.trim())
    .slice(0, 5)
    .map((item) => item.index + 1);

  return {
    slug: slugify(source.path || source.title),
    title: source.title,
    summary,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceLinks: linkedLines.map((line) => ({
      path: source.path,
      line,
      label: `${source.path}:${line}`,
    })),
    checksum: checksum(`${source.path}\n${source.content}`),
    updatedAt: source.createdAt,
  };
}

export function buildArchitectureDiagram(sources: WikiSource[]) {
  const groups = new Map<string, number>();
  for (const source of sources) {
    const group = classifySourceGroup(source);
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  const nodes = Array.from(groups.keys()).sort();
  const lines = ["graph TD", "  company[Company Knowledge]"];
  for (const node of nodes) {
    lines.push(`  ${node}[${labelForGroup(node)}]`);
    lines.push(`  company --> ${node}`);
  }
  if (nodes.includes("app_api") && nodes.includes("lib")) lines.push("  app_api --> lib");
  if (nodes.includes("workbench") && nodes.includes("artifacts")) lines.push("  workbench --> artifacts");
  if (nodes.includes("memory")) lines.push("  memory --> company");

  return {
    id: "architecture",
    kind: "mermaid" as const,
    title: "Architecture Map",
    content: lines.join("\n"),
    generatedAt: latestCreatedAt(sources) ?? new Date(0).toISOString(),
  };
}

export function shouldReindexFromWorkbenchEvent(event: Pick<WorkbenchEvent, "type" | "status">) {
  return event.status === "completed" && (event.type === "file" || event.type === "deploy");
}

export function diffWikiVersions(previous: PriorPage[], current: PriorPage[]) {
  const previousBySlug = new Map(previous.map((page) => [page.slug, page]));
  const currentBySlug = new Map(current.map((page) => [page.slug, page]));
  const added = current.filter((page) => !previousBySlug.has(page.slug)).map((page) => page.slug).sort();
  const removed = previous.filter((page) => !currentBySlug.has(page.slug)).map((page) => page.slug).sort();
  const changed = current
    .filter((page) => previousBySlug.has(page.slug) && previousBySlug.get(page.slug)?.checksum !== page.checksum)
    .map((page) => page.slug)
    .sort();

  return { added, changed, removed };
}

export function buildIndexFreshnessTelemetry(input: {
  generatedAt: string;
  latestSourceAt?: string;
  sourceCount: number;
  chunkCount: number;
  usageCents: number;
  budgetCents: number;
}) {
  const latest = input.latestSourceAt ? new Date(input.latestSourceAt).getTime() : new Date(input.generatedAt).getTime();
  const generated = new Date(input.generatedAt).getTime();
  const ageSeconds = Math.max(0, Math.round((generated - latest) / 1000));
  return {
    generatedAt: input.generatedAt,
    latestSourceAt: input.latestSourceAt,
    ageSeconds,
    isStale: ageSeconds > 60 * 60 * 24,
    sourceCount: input.sourceCount,
    chunkCount: input.chunkCount,
    costTelemetry: {
      usageCents: input.usageCents,
      budgetCents: input.budgetCents,
      remainingCents: Math.max(0, input.budgetCents - input.usageCents),
    },
  };
}

export function buildWikiSources(input: {
  sessions: WorkbenchSession[];
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
  documents: Document[];
}) {
  const sessionSources = input.sessions.map((session) => ({
    id: session.id,
    kind: "session" as const,
    title: session.objective,
    path: `workbench/${session.id}.md`,
    content: [
      `Objective: ${session.objective}`,
      `Agent: ${session.agentRole}`,
      `Status: ${session.status}`,
      session.repoUrl ? `Repo: ${session.repoUrl}` : "",
      session.workdir ? `Workdir: ${session.workdir}` : "",
    ].filter(Boolean).join("\n"),
    createdAt: session.updatedAt,
  }));
  const eventSources = input.events.map((event) => ({
    id: event.id,
    kind: "event" as const,
    title: event.title,
    path: `workbench/${event.sessionId}/events/${event.id}.md`,
    content: [event.title, event.content, event.command ? `Command: ${event.command}` : ""].filter(Boolean).join("\n"),
    createdAt: event.createdAt,
  }));
  const artifactSources = input.artifacts.map((artifact) => ({
    id: artifact.id,
    kind: "artifact" as const,
    title: artifact.title,
    path: artifact.storageKey,
    content: `${artifact.title}\nKind: ${artifact.kind}\nMIME: ${artifact.mimeType}\nSize: ${artifact.sizeBytes}`,
    createdAt: artifact.createdAt,
  }));
  const memorySources = input.documents
    .filter((doc) => doc.source !== "trench_wiki_indexer")
    .map((doc) => ({
      id: doc.id,
      kind: "memory" as const,
      title: doc.title,
      path: `memory/${doc.id}.md`,
      content: doc.content,
      createdAt: doc.createdAt,
    }));

  return [...sessionSources, ...eventSources, ...artifactSources, ...memorySources].filter((source) => isIndexableWikiPath(source.path));
}

export function buildTrenchWikiIndex(input: {
  companyId: string;
  sessions: WorkbenchSession[];
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
  documents: Document[];
  usage?: Array<Pick<UsageLedgerEntry, "amountCents">>;
  usageCents?: number;
  budgetCents: number;
  generatedAt?: string;
}): WikiIndex {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sources = buildWikiSources(input);
  const pages = sources.map(buildWikiPageSummary).sort((a, b) => a.title.localeCompare(b.title));
  const chunks = sources.flatMap((source) => chunkWikiSource(source));
  const previous = parsePreviousIndex(input.documents);
  const latestSourceAt = latestCreatedAt(sources);
  const usageCents = input.usageCents ?? input.usage?.reduce((sum, item) => sum + item.amountCents, 0) ?? 0;

  return {
    companyId: input.companyId,
    generatedAt,
    tree: buildWikiTree(sources),
    pages,
    diagrams: [buildArchitectureDiagram(sources)],
    versions: {
      previousGeneratedAt: previous?.generatedAt,
      diff: diffWikiVersions(previous?.pages ?? [], pages),
    },
    freshness: buildIndexFreshnessTelemetry({
      generatedAt,
      latestSourceAt,
      sourceCount: sources.length,
      chunkCount: chunks.length,
      usageCents,
      budgetCents: input.budgetCents,
    }),
  };
}

export function buildWikiTree(sources: WikiSource[]) {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const label = treeLabelForSource(source);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return {
    nodes: Array.from(counts.entries())
      .map(([label, count]) => ({ id: slugify(label), label, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function treeLabelForSource(source: WikiSource) {
  if (source.kind === "event" || source.kind === "session") return "Workbench";
  if (source.kind === "memory") return "Memory";
  if (source.kind === "artifact") return "Artifacts";
  if (source.kind === "file") return "Files";
  return titleCase(source.kind);
}

function parsePreviousIndex(documents: Document[]) {
  const doc = documents
    .filter((item) => item.source === "trench_wiki_indexer")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!doc) return undefined;
  try {
    const parsed = JSON.parse(doc.content) as { generatedAt?: string; pages?: PriorPage[] };
    return { generatedAt: parsed.generatedAt, pages: parsed.pages ?? [] };
  } catch {
    return undefined;
  }
}

function classifySourceGroup(source: WikiSource) {
  if (source.path.startsWith("app/api/")) return "app_api";
  if (source.path.startsWith("app/")) return "app";
  if (source.path.startsWith("lib/")) return "lib";
  if (source.path.startsWith("components/")) return "components";
  if (source.kind === "memory") return "memory";
  if (source.kind === "artifact") return "artifacts";
  if (source.kind === "event" || source.kind === "session") return "workbench";
  return "workspace";
}

function labelForGroup(group: string) {
  const labels: Record<string, string> = {
    app_api: "API Routes",
    app: "App Routes",
    lib: "Domain Libraries",
    components: "UI Components",
    memory: "Company Memory",
    artifacts: "Workbench Artifacts",
    workbench: "Workbench Events",
    workspace: "Workspace",
  };
  return labels[group] ?? titleCase(group);
}

function latestCreatedAt(sources: Array<{ createdAt: string }>) {
  return sources.map((source) => source.createdAt).sort().at(-1);
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function titleCase(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
