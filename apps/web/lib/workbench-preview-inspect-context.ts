/** Ephemeral per-session inspect hints for live cloud proofs (not persisted). */
const contextBySession = new Map<string, { expectedTexts?: string[] }>();

export function setPreviewInspectContext(
  sessionId: string,
  input: { expectedTexts?: string[] },
): void {
  contextBySession.set(sessionId, input);
}

export function getPreviewInspectContext(sessionId: string): { expectedTexts?: string[] } | undefined {
  return contextBySession.get(sessionId);
}

export function clearPreviewInspectContext(sessionId: string): void {
  contextBySession.delete(sessionId);
}

export function defaultCloudProofExpectedTexts(): string[] {
  return ["Cloud Notes", "Save note"];
}
