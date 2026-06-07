import type { Document } from "@/lib/types";

export function isDocumentActive(document: Pick<Document, "validFrom" | "validTo">, atIso = new Date().toISOString()) {
  const at = Date.parse(atIso);
  if (document.validFrom && Date.parse(document.validFrom) > at) return false;
  if (document.validTo && Date.parse(document.validTo) <= at) return false;
  return true;
}

export function filterActiveDocuments<T extends Pick<Document, "validFrom" | "validTo">>(documents: T[], atIso?: string): T[] {
  return documents.filter((document) => isDocumentActive(document, atIso));
}
