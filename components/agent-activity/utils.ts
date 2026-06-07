export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function detectLanguage(filename?: string, content?: string): string {
  if (!filename && !content) return "text";
  const name = filename ?? "";
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    sql: "sql",
  };
  if (ext && map[ext]) return map[ext];
  if (content?.trimStart().startsWith("{") || content?.trimStart().startsWith("[")) return "json";
  if (content?.includes("import ") && content.includes(" from ")) return "typescript";
  return "text";
}

export function makeStepId(prefix: string, index: number, suffix = ""): string {
  return `${prefix}-${index}${suffix ? `-${suffix}` : ""}`;
}

export function phaseLabel(phase: string): string {
  return phase.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
