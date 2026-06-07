import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolAdapter } from "@/lib/tools";
import { store as defaultStore } from "@/lib/store";
import type { AgentRole, Document, ToolCallRecord } from "@/lib/types";

const execFileAsync = promisify(execFile);

export type VaultMemoryScope = {
  companyId: string;
  role?: AgentRole;
  agentId?: string;
  artifactId?: string;
};

export type VaultMemoryWriteInput = VaultMemoryScope & {
  type?: Document["type"];
  title: string;
  content: string;
  source?: string;
  memoryTier?: Document["memoryTier"];
};

export type VaultMemoryRecord = {
  namespace: string;
  document: Document;
  vaultPath: string;
  graphNodeId: string;
};

export type VaultMemoryProvider = {
  write(input: VaultMemoryWriteInput): Promise<VaultMemoryRecord>;
  list(scope: VaultMemoryScope): Promise<VaultMemoryRecord[]>;
  search(scope: VaultMemoryScope, query: string): Promise<VaultMemoryRecord[]>;
  companyVaultPath(companyId: string): string;
};

type TrentStore = Pick<typeof defaultStore, "createDocument" | "listDocuments">;

export function vaultMemoryToolScopes() {
  return [
    "vault:read",
    "vault:write",
    "vault:graph",
    "gitnexus:search",
    "gitnexus:context",
  ];
}

export function vaultMemoryApprovalGates() {
  return [
    "vault.reindex",
    "vault.export",
    "vault.delete",
    "gitnexus.analyze",
    "gitnexus.clean",
  ];
}

export function defaultVaultRoot() {
  return path.resolve(process.cwd(), ".trent", "vault");
}

export function buildVaultMemoryNamespace(scope: VaultMemoryScope) {
  return [
    `company:${scope.companyId}`,
    scope.role ? `agent:${scope.role}` : undefined,
    scope.agentId ? `profile:${scope.agentId}` : undefined,
    scope.artifactId ? `artifact:${scope.artifactId}` : undefined,
  ].filter(Boolean).join("/");
}

function safeSegment(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 96) || "untitled";
}

function parseVaultSource(source: string): VaultMemoryScope | undefined {
  if (!source.startsWith("vault:")) return undefined;
  const namespace = source.slice("vault:".length);
  const scope: Partial<VaultMemoryScope> = {};
  for (const part of namespace.split("/")) {
    const [key, value] = part.split(":");
    if (key === "company") scope.companyId = value;
    if (key === "agent") scope.role = value as AgentRole;
    if (key === "profile") scope.agentId = value;
    if (key === "artifact") scope.artifactId = value;
  }
  return scope.companyId ? scope as VaultMemoryScope : undefined;
}

function scopeMatches(filter: VaultMemoryScope, sourceScope: VaultMemoryScope) {
  return sourceScope.companyId === filter.companyId
    && (!filter.role || sourceScope.role === filter.role)
    && (!filter.agentId || sourceScope.agentId === filter.agentId)
    && (!filter.artifactId || sourceScope.artifactId === filter.artifactId);
}

function filePathForDocument(rootDir: string, scope: VaultMemoryScope, doc: Pick<Document, "id" | "title">) {
  const parts = [
    rootDir,
    safeSegment(scope.companyId),
    scope.role ? safeSegment(scope.role) : "company",
    scope.agentId ? safeSegment(scope.agentId) : "default",
    scope.artifactId ? safeSegment(scope.artifactId) : "general",
  ];
  return path.join(...parts, `${safeSegment(doc.title)}-${doc.id}.md`);
}

function renderVaultMarkdown(namespace: string, input: VaultMemoryWriteInput, doc: Document) {
  return [
    "---",
    `id: ${doc.id}`,
    `companyId: ${input.companyId}`,
    `namespace: ${namespace}`,
    input.role ? `role: ${input.role}` : "role: company",
    input.agentId ? `agentId: ${input.agentId}` : "agentId: default",
    input.artifactId ? `artifactId: ${input.artifactId}` : "artifactId: general",
    `type: ${doc.type}`,
    `memoryTier: ${doc.memoryTier ?? "semantic"}`,
    `createdAt: ${doc.createdAt}`,
    "---",
    "",
    `# ${doc.title}`,
    "",
    doc.content,
    "",
  ].join("\n");
}

export class LocalVaultMemoryProvider implements VaultMemoryProvider {
  private rootDir: string;
  private store: TrentStore;

  constructor(options: { rootDir?: string; store?: TrentStore } = {}) {
    this.rootDir = options.rootDir ?? defaultVaultRoot();
    this.store = options.store ?? defaultStore;
  }

  companyVaultPath(companyId: string) {
    return path.join(this.rootDir, safeSegment(companyId));
  }

  async write(input: VaultMemoryWriteInput): Promise<VaultMemoryRecord> {
    const namespace = buildVaultMemoryNamespace(input);
    const document = await this.store.createDocument({
      companyId: input.companyId,
      type: input.type ?? "agent_note",
      title: input.title,
      content: input.content,
      source: `vault:${namespace}${input.source ? `/${safeSegment(input.source)}` : ""}`,
      memoryTier: input.memoryTier ?? "semantic",
    });
    const vaultPath = filePathForDocument(this.rootDir, input, document);
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(vaultPath, renderVaultMarkdown(namespace, input, document), "utf8");

    return {
      namespace,
      document,
      vaultPath,
      graphNodeId: `document:${document.id}`,
    };
  }

  async list(scope: VaultMemoryScope): Promise<VaultMemoryRecord[]> {
    const documents = await this.store.listDocuments(scope.companyId);
    return documents.flatMap((document) => {
      const sourceScope = parseVaultSource(document.source);
      if (!sourceScope || !scopeMatches(scope, sourceScope)) return [];
      return [{
        namespace: buildVaultMemoryNamespace(sourceScope),
        document,
        vaultPath: filePathForDocument(this.rootDir, sourceScope, document),
        graphNodeId: `document:${document.id}`,
      }];
    });
  }

  async search(scope: VaultMemoryScope, query: string): Promise<VaultMemoryRecord[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const records = await this.list(scope);
    return records.filter((record) =>
      `${record.document.title}\n${record.document.content}`.toLowerCase().includes(normalized),
    );
  }
}

export class GitNexusVaultIndexAdapter implements ToolAdapter {
  name = "GitNexus Vault";
  scopes = ["vault:index", "vault:search", "vault:graph", "gitnexus:mcp"];
  private vaultRoot: string;
  private enabled: boolean;

  constructor(options: { vaultRoot?: string; enabled?: boolean } = {}) {
    this.vaultRoot = options.vaultRoot ?? defaultVaultRoot();
    this.enabled = options.enabled ?? process.env.GITNEXUS_VAULT_ENABLED === "1";
  }

  async healthCheck(): Promise<"mocked" | "connected" | "needs_credentials"> {
    return this.enabled ? "connected" : "mocked";
  }

  estimateCost() {
    return 0;
  }

  requiresApproval(action: string) {
    return ["reindex", "export", "delete", "clean", "analyze"].some((word) =>
      action.toLowerCase().includes(word),
    );
  }

  buildAnalyzeCommand(companyId: string) {
    return {
      command: "npx",
      args: [
        "-y",
        "gitnexus@latest",
        "analyze",
        path.join(this.vaultRoot, companyId),
        "--skip-agents-md",
        "--skip-git",
      ],
    };
  }

  async execute(action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> {
    const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
    if (!companyId) {
      return { adapter: this.name, action, status: "failed", summary: "GitNexus Vault requires payload.companyId." };
    }

    if (this.requiresApproval(action)) {
      return {
        adapter: this.name,
        action,
        status: "needs_approval",
        summary: `GitNexus Vault action "${action}" is approval-gated before reindex/export/delete operations run.`,
      };
    }

    if (action === "search" || action === "graph" || action === "context") {
      return {
        adapter: this.name,
        action,
        status: this.enabled ? "completed" : "mocked",
        summary: `GitNexus Vault search is configured as local-only indexed memory for ${companyId}. ${this.enabled ? "Use the GitNexus MCP/server for live graph retrieval." : "Set GITNEXUS_VAULT_ENABLED=1 after local review to execute live GitNexus commands."}`,
      };
    }

    return { adapter: this.name, action, status: "failed", summary: `Unsupported GitNexus Vault action "${action}".` };
  }

  async dryRun(action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> {
    const companyId = typeof payload.companyId === "string" ? payload.companyId : "unknown_company";
    const command = this.buildAnalyzeCommand(companyId);
    return {
      adapter: this.name,
      action,
      status: this.requiresApproval(action) ? "needs_approval" : "mocked",
      summary: `GitNexus Vault dry-run: ${command.command} ${command.args.join(" ")}`,
    };
  }

  async runApprovedReindex(companyId: string): Promise<ToolCallRecord> {
    const command = this.buildAnalyzeCommand(companyId);
    await execFileAsync(command.command, command.args, { cwd: process.cwd() });
    return {
      adapter: this.name,
      action: "reindex",
      status: "completed",
      summary: `GitNexus reindexed the local vault for ${companyId}.`,
    };
  }
}
