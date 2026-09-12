import { createHash } from "crypto";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchExportResult,
  WorkbenchFileDiff,
  WorkbenchFileEntry,
  WorkbenchFileTreeOptions,
  WorkbenchSandboxSnapshot,
} from "@/lib/workbench-provider";
import { makeId, nowIso } from "@/lib/utils";

const IGNORED_TREE_NAMES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

export type ProviderFileTreeAdapter = {
  listFiles(session: WorkbenchSession, path?: string): Promise<WorkbenchFileEntry[]>;
  captureArtifact(
    session: WorkbenchSession,
    input: {
      title: string;
      kind: "export";
      mimeType: string;
      content: string;
    }
  ): Promise<WorkbenchExportResult>;
};

export async function getProviderFileTree(
  adapter: Pick<ProviderFileTreeAdapter, "listFiles">,
  session: WorkbenchSession,
  options?: WorkbenchFileTreeOptions,
): Promise<WorkbenchFileEntry[]> {
  const depth = options?.depth ?? 4;
  const includeIgnored = options?.includeIgnored ?? false;
  const files = await walkFileTree(adapter, session, ".", depth, includeIgnored);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function diffProviderFileTree(
  adapter: Pick<ProviderFileTreeAdapter, "listFiles">,
  session: WorkbenchSession,
  checkpointHash?: string,
): Promise<WorkbenchFileDiff> {
  const files = await getProviderFileTree(adapter, session, { depth: 8 });
  const toHash = hashProviderFileTree(files);
  const changedPaths = checkpointHash === toHash
    ? []
    : files.filter((file) => !file.isDir).map((file) => file.path);
  return {
    changedPaths,
    summary: changedPaths.length
      ? `${changedPaths.length} files differ from checkpoint`
      : "No file tree changes since checkpoint",
    fromHash: checkpointHash,
    toHash,
  };
}

export async function snapshotProviderFileTree(
  adapter: Pick<ProviderFileTreeAdapter, "listFiles">,
  session: WorkbenchSession,
  providerSessionId?: string,
): Promise<WorkbenchSandboxSnapshot> {
  const files = await getProviderFileTree(adapter, session, { depth: 8 });
  return {
    id: makeId("wbsnap"),
    fileTreeHash: hashProviderFileTree(files),
    createdAt: nowIso(),
    metadata: {
      fileCount: files.filter((file) => !file.isDir).length,
      providerSessionId,
    },
  };
}

export async function exportProviderArtifacts(
  adapter: ProviderFileTreeAdapter,
  session: WorkbenchSession,
): Promise<WorkbenchExportResult> {
  const files = await getProviderFileTree(adapter, session, { depth: 8 });
  return adapter.captureArtifact(session, {
    title: "Workbench artifact manifest",
    kind: "export",
    mimeType: "text/markdown",
    content: files.map((file) => `- ${file.isDir ? "dir" : "file"} ${file.path}`).join("\n"),
  });
}

export function normalizeWorkbenchPath(path: string, rootPrefix?: string): string {
  let normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rootPrefix && normalized.startsWith(rootPrefix)) {
    normalized = normalized.slice(rootPrefix.length);
  }
  normalized = normalized.replace(/^\/+/, "");
  return normalized || ".";
}

export function hashProviderFileTree(files: WorkbenchFileEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}:${file.isDir ? "dir" : file.sizeBytes}:${file.modifiedAt}\n`);
  }
  return hash.digest("hex");
}

async function walkFileTree(
  adapter: Pick<ProviderFileTreeAdapter, "listFiles">,
  session: WorkbenchSession,
  dirPath: string,
  depth: number,
  includeIgnored: boolean,
): Promise<WorkbenchFileEntry[]> {
  if (depth < 0) return [];
  const entries = await adapter.listFiles(session, dirPath);
  const results: WorkbenchFileEntry[] = [];
  for (const entry of entries) {
    if (!includeIgnored && shouldIgnore(entry)) continue;
    results.push(entry);
    if (entry.isDir) {
      results.push(...await walkFileTree(adapter, session, entry.path, depth - 1, includeIgnored));
    }
  }
  return results;
}

function shouldIgnore(file: WorkbenchFileEntry): boolean {
  return file.path
    .split("/")
    .some((part) => IGNORED_TREE_NAMES.has(part));
}
