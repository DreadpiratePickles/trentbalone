import { describe, expect, it } from "vitest";
import {
  buildCompanyMemoryUploadPayload,
  isSupportedCompanyMemoryFile,
} from "@/lib/company-memory-upload";

describe("company memory upload helpers", () => {
  it("builds a semantic document payload from uploaded company context", () => {
    expect(buildCompanyMemoryUploadPayload({
      companyId: "co_1",
      title: "",
      fileName: "northstar-intake.md",
      content: "  ICP: independent field-service operators  ",
      type: "brief",
    })).toEqual({
      companyId: "co_1",
      title: "northstar-intake.md",
      content: "ICP: independent field-service operators",
      type: "brief",
      source: "user_upload",
      memoryTier: "semantic",
    });
  });

  it("rejects empty company context before the API request", () => {
    expect(() => buildCompanyMemoryUploadPayload({
      companyId: "co_1",
      title: "Empty",
      content: "   ",
      type: "brief",
    })).toThrow("Company memory content is required");
  });

  it("allows text-like files and rejects binary uploads for the first UI pass", () => {
    expect(isSupportedCompanyMemoryFile({
      name: "brief.md",
      type: "text/markdown",
      size: 1024,
    })).toEqual({ ok: true });

    expect(isSupportedCompanyMemoryFile({
      name: "deck.pdf",
      type: "application/pdf",
      size: 1024,
    })).toEqual({
      ok: false,
      error: "Upload a text, markdown, JSON, CSV, or TSV file.",
    });
  });
});
