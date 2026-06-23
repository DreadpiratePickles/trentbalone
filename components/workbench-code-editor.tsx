"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { readApiError } from "@/lib/read-api-error";

// Monaco touches `window`, so load it client-only. On the server (and in the
// static-markup tests) this renders the lightweight fallback instead.
const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div style={S.loading} className="mono">opening editor…</div>,
});

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", scss: "scss", less: "less", html: "html", md: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp",
  php: "php", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql", prisma: "prisma",
  env: "ini", dockerfile: "dockerfile", svg: "xml", xml: "xml",
};

function languageForPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANGUAGE[ext] ?? "plaintext";
}

export function WorkbenchCodeEditor({
  sessionId,
  path,
  initialContent,
  editable,
  onSaved,
}: {
  sessionId: string;
  path: string;
  initialContent: string;
  editable: boolean;
  onSaved?: () => void;
}) {
  const [value, setValue] = useState(initialContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the file or its loaded content changes.
  useEffect(() => {
    setValue(initialContent);
    setDirty(false);
    setError(null);
  }, [path, initialContent]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workbench/${sessionId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "write", path, content: value }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      setDirty(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, sessionId, path, value, onSaved]);

  return (
    <div
      style={S.wrap}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div style={S.head}>
        <span className="mono" style={S.path} title={path}>{path}{dirty ? " ●" : ""}</span>
        {editable ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            style={S.saveBtn(dirty && !saving)}
            title="Save file to the sandbox (⌘S)"
          >
            {saving ? "saving…" : dirty ? "save ⌘S" : "saved"}
          </button>
        ) : (
          <span className="mono" style={S.readonly}>read-only</span>
        )}
      </div>
      {error && <div style={S.error}>{error}</div>}
      <div style={S.editor}>
        <MonacoEditor
          path={path}
          language={languageForPath(path)}
          value={value}
          onChange={(next) => { setValue(next ?? ""); setDirty(true); }}
          theme="vs-dark"
          options={{
            readOnly: !editable,
            fontSize: 12,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
            lineNumbersMinChars: 3,
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.07)";

const S = {
  wrap: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, border, borderRadius: 8, overflow: "hidden", background: "#1e1e1e" } as React.CSSProperties,
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderBottom: border, background: "rgba(255,255,255,.03)" } as React.CSSProperties,
  path: { fontSize: 11, color: "var(--bone)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as React.CSSProperties,
  saveBtn: (active: boolean) => ({ height: 22, padding: "0 8px", borderRadius: 6, border: active ? "1px solid rgba(110,231,183,.32)" : border, background: active ? "rgba(110,231,183,.1)" : "transparent", color: active ? "var(--pulse)" : "var(--haze)", fontSize: 10, fontWeight: 800, cursor: active ? "pointer" : "default", whiteSpace: "nowrap" }) as React.CSSProperties,
  readonly: { fontSize: 10, color: "var(--haze)", textTransform: "uppercase", letterSpacing: ".1em" } as React.CSSProperties,
  error: { padding: "6px 10px", fontSize: 11, color: "var(--ember)", background: "rgba(251,146,60,.1)", borderBottom: border } as React.CSSProperties,
  editor: { flex: 1, minHeight: 0 } as React.CSSProperties,
  loading: { height: "100%", minHeight: 160, display: "grid", placeItems: "center", color: "var(--haze)", fontSize: 12, background: "#1e1e1e" } as React.CSSProperties,
};
