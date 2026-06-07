import { describe, expect, it } from "vitest";
import type { Document } from "@/lib/types";
import { filterActiveDocuments } from "./active-documents";

describe("active document reads", () => {
  it("keeps only documents valid at the requested instant", () => {
    const now = "2026-05-30T12:00:00.000Z";
    const docs = [
      doc("current", { validFrom: "2026-05-30T00:00:00.000Z" }),
      doc("expired", { validTo: "2026-05-30T11:59:59.000Z" }),
      doc("future", { validFrom: "2026-05-30T12:01:00.000Z" }),
      doc("open"),
    ];

    expect(filterActiveDocuments(docs, now).map((item) => item.id)).toEqual(["current", "open"]);
  });
});

function doc(id: string, patch: Partial<Document> = {}): Document {
  return {
    id,
    companyId: "co_1",
    type: "agent_note",
    title: id,
    content: id,
    source: "test",
    version: 1,
    createdAt: "2026-05-30T00:00:00.000Z",
    ...patch,
  };
}
