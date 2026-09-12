import type { AgentRole, Document } from "@/lib/types";

export type VaultGraphNode = {
  id: string;
  label: string;
  kind: "company" | "role" | "document";
  count?: number;
};

export type VaultGraphEdge = {
  from: string;
  to: string;
  label: "owns" | "remembers";
};

export type VaultGraphDocument = {
  id: string;
  title: string;
  role: AgentRole | "company";
  excerpt: string;
  source: string;
  createdAt: string;
};

export type VaultGraphModel = {
  status: {
    mode: "internal_local";
    indexer: "gitnexus";
    gitNexusEnabled: boolean;
    destructiveActionsRequireApproval: boolean;
  };
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
  documents: VaultGraphDocument[];
};

type BuildVaultGraphModelInput = {
  companyId: string;
  documents: Document[];
  gitNexusEnabled?: boolean;
};

function roleFromSource(source: string): AgentRole | "company" {
  const match = source.match(/(?:^|\/)agent:([^/]+)/);
  return match?.[1] ? match[1] as AgentRole : "company";
}

function excerpt(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function buildVaultGraphModel(input: BuildVaultGraphModelInput): VaultGraphModel {
  const vaultDocuments = input.documents
    .filter((document) => document.companyId === input.companyId && document.source.startsWith("vault:"))
    .map((document): VaultGraphDocument => ({
      id: document.id,
      title: document.title,
      role: roleFromSource(document.source),
      excerpt: excerpt(document.content),
      source: document.source,
      createdAt: document.createdAt,
    }));

  const roleCounts = new Map<AgentRole | "company", number>();
  for (const document of vaultDocuments) {
    roleCounts.set(document.role, (roleCounts.get(document.role) ?? 0) + 1);
  }

  const nodes: VaultGraphNode[] = [
    { id: `company:${input.companyId}`, label: "Company Vault", kind: "company", count: vaultDocuments.length },
    ...Array.from(roleCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, count]) => ({ id: `role:${role}`, label: role, kind: "role" as const, count })),
    ...vaultDocuments.map((document) => ({
      id: `document:${document.id}`,
      label: document.title,
      kind: "document" as const,
    })),
  ];

  const edges: VaultGraphEdge[] = [
    ...Array.from(roleCounts.keys()).map((role) => ({
      from: `company:${input.companyId}`,
      to: `role:${role}`,
      label: "owns" as const,
    })),
    ...vaultDocuments.map((document) => ({
      from: `role:${document.role}`,
      to: `document:${document.id}`,
      label: "remembers" as const,
    })),
  ];

  return {
    status: {
      mode: "internal_local",
      indexer: "gitnexus",
      gitNexusEnabled: input.gitNexusEnabled === true,
      destructiveActionsRequireApproval: true,
    },
    nodes,
    edges,
    documents: vaultDocuments,
  };
}
