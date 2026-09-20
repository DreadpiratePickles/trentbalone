/**
 * U5 — the frontmatter parser reads a nested map. The Agent Skills specification and Hermes both
 * put vendor fields under `metadata:`; Trent's own fields travel there as `metadata.trent.*` when a
 * skill is exported for another harness. Before this the line-by-line parser flattened a nested
 * block into bogus top-level keys (`trent: ""`, and a nested `trust` overwrote the real one).
 * Nested keys parse as dotted keys, render back as the same nested block, and Trent's own fields
 * under `metadata.trent` are read as the store's flat fields so a re-import keeps trust, status
 * and provenance.
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatter, renderFrontmatter } from "./skill-store.js";

const NESTED = `---
name: quote-estimate
description: "Draft a quote from a job description."
metadata:
  trent:
    trust: trusted
    status: archived
    created_by: agent
  hermes:
    tags: [sales, quotes]
    related_skills:
      - invoice-draft
      - booking-followup
allowed-tools: Read, Bash
---
# Quote estimate

Body text.
`;

describe("parseFrontmatter with a nested metadata map", () => {
  it("reads nested keys as dotted keys, hoists metadata.trent.* onto the flat fields the store reads, and keeps the body", () => {
    const { fields, body } = parseFrontmatter(NESTED);
    expect(fields.name).toBe("quote-estimate");
    expect(fields.description).toBe("Draft a quote from a job description.");
    expect(fields.trust).toBe("trusted");
    expect(fields.status).toBe("archived");
    expect(fields.created_by).toBe("agent");
    expect(fields["metadata.hermes.tags"]).toBe("[sales, quotes]");
    expect(fields["metadata.hermes.related_skills"]).toBe("invoice-draft, booking-followup");
    expect(fields["allowed-tools"]).toBe("Read, Bash");
    // Nothing bogus: no empty `metadata`, `trent` or `hermes` scalar keys.
    expect(fields.metadata).toBeUndefined();
    expect(fields.trent).toBeUndefined();
    expect(fields.hermes).toBeUndefined();
    expect(body).toBe("# Quote estimate\n\nBody text.\n");
  });

  it("never lets a nested field overwrite a top-level one of the same name", () => {
    const { fields } = parseFrontmatter("---\ntrust: builtin\nmetadata:\n  trent:\n    trust: community\n---\n");
    expect(fields.trust).toBe("builtin");
  });

  it("renders dotted keys back as a nested block, so a parse-render round trip keeps the map", () => {
    const { fields, body } = parseFrontmatter(NESTED);
    const rendered = renderFrontmatter(fields, body);
    expect(rendered).toContain("metadata:\n  hermes:\n    tags: [sales, quotes]\n    related_skills: invoice-draft, booking-followup");
    const again = parseFrontmatter(rendered);
    expect(again.fields).toEqual(fields);
    expect(again.body).toBe(body);
  });

  it("still reads a flat file exactly as before", () => {
    const { fields, body } = parseFrontmatter("---\nname: a\ndescription: b: c\n---\nBody");
    expect(fields).toEqual({ name: "a", description: "b: c" });
    expect(body).toBe("Body");
    expect(renderFrontmatter(fields, body)).toBe("---\nname: a\ndescription: b: c\n---\nBody");
  });
});
