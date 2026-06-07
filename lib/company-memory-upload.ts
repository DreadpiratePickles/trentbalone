import type { Document } from "@/lib/types";

export type CompanyMemoryUploadPayload = {
  companyId: string;
  title?: string;
  fileName?: string;
  content: string;
  type?: Document["type"] | string;
};

const MAX_MEMORY_UPLOAD_BYTES = 512 * 1024;
const supportedExtensions = [".txt", ".md", ".markdown", ".json", ".csv", ".tsv"];
const supportedMimeTypes = [
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "text/tab-separated-values",
  "",
];

export function isSupportedCompanyMemoryFile(file: { name: string; type: string; size: number }) {
  if (file.size > MAX_MEMORY_UPLOAD_BYTES) {
    return { ok: false as const, error: "Upload a file smaller than 512 KB." };
  }

  const name = file.name.toLowerCase();
  const hasSupportedExtension = supportedExtensions.some((ext) => name.endsWith(ext));
  const hasSupportedMimeType = supportedMimeTypes.includes(file.type);
  if (!hasSupportedExtension && !hasSupportedMimeType) {
    return {
      ok: false as const,
      error: "Upload a text, markdown, JSON, CSV, or TSV file.",
    };
  }

  return { ok: true as const };
}

export function buildCompanyMemoryUploadPayload(input: CompanyMemoryUploadPayload) {
  const content = input.content.trim();
  if (!content) throw new Error("Company memory content is required");

  const title = (input.title?.trim() || input.fileName?.trim() || "Company information").slice(0, 160);

  return {
    companyId: input.companyId,
    title,
    content,
    type: input.type ?? "brief",
    source: "user_upload",
    memoryTier: "semantic" as const,
  };
}
