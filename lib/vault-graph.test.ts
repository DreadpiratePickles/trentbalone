import { describe, expect, it } from "vitest";
import { buildVaultGraphModel } from "@/lib/vault-graph";
import type { Document } from "@/lib/types";

function doc(input: Partial<Document> & Pick<Document, "id" | "title" | "source" | "content">): Document {
  return {
    companyId: "co_graph",
    type: "agent_note",
    version: 1,
    createdAt: "2026-06-03T12:00:00.000Z",
    ...input,
  };
}

describe("buildVaultGraphModel", () => {
  it("builds a read-only vault graph from scoped memory documents", () => {
    const graph = buildVaultGraphModel({
      companyId: "co_graph",
      documents: [
        doc({
          id: "doc_1",
          title: "Engineer decision",
          source: "vault:company:co_graph/agent:engineer/profile:eng/artifact:art_1",
          content: "Build the provider first.",
        }),
        doc({
          id: "doc_2",
          title: "Support pattern",
          source: "vault:company:co_graph/agent:support",
          content: "Escalate refunds.",
        }),
      ],
      gitNexusEnabled: false,
    });

    expect(graph.status.mode).toBe("internal_local");
    expect(graph.status.indexer).toBe("gitnexus");
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "company:co_graph",
      "role:engineer",
      "role:support",
      "document:doc_1",
      "document:doc_2",
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: "company:co_graph", to: "role:engineer", label: "owns" },
      { from: "role:engineer", to: "document:doc_1", label: "remembers" },
    ]));
    expect(graph.documents[0]).toMatchObject({
      id: "doc_1",
      role: "engineer",
      title: "Engineer decision",
    });
  });
});
