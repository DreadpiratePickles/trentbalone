export type WorkbenchPreviewFrameSession = {
  id: string;
  previewUrl?: string;
};

export function workbenchPreviewFrameSrc(session: WorkbenchPreviewFrameSession): string {
  if (!session.previewUrl) return "";
  try {
    const url = new URL(session.previewUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      return `/api/workbench/${session.id}/preview/`;
    }
  } catch {
    return session.previewUrl;
  }
  return session.previewUrl;
}
