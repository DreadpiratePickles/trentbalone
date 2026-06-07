"use client";

import { useRef, useState } from "react";
import type { Document } from "@/lib/types";
import {
  buildCompanyMemoryUploadPayload,
  isSupportedCompanyMemoryFile,
} from "@/lib/company-memory-upload";
import { I } from "@/components/ui";

type Props = {
  companyId: string;
  variant?: "primary" | "secondary";
  label?: string;
  onUploaded?: (document: Document) => void;
};

const documentTypes: Array<{ value: Document["type"]; label: string }> = [
  { value: "brief", label: "company brief" },
  { value: "roadmap", label: "roadmap" },
  { value: "marketing_plan", label: "marketing plan" },
  { value: "research", label: "research" },
  { value: "support_summary", label: "support summary" },
  { value: "agent_note", label: "agent note" },
];

export function CompanyMemoryUploadButton({
  companyId,
  variant = "secondary",
  label = "add memory",
  onUploaded,
}: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<Document["type"]>("brief");
  const [fileName, setFileName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    setError("");
    if (!file) return;
    const support = isSupportedCompanyMemoryFile(file);
    if (!support.ok) {
      setError(support.error);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    if (!title.trim()) setTitle(file.name);
    setContent(text);
  }

  async function save() {
    setError("");
    setSaving(true);
    try {
      const payload = buildCompanyMemoryUploadPayload({
        companyId,
        title,
        fileName,
        content,
        type,
      });
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { document?: Document; error?: string };
      if (!res.ok || !data.document) {
        throw new Error(data.error ?? "Memory upload failed");
      }
      onUploaded?.(data.document);
      setOpen(false);
      setTitle("");
      setContent("");
      setFileName("");
      setType("brief");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Memory upload failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        className={`btn btn-mono ${variant === "primary" ? "btn-pulse" : "btn-secondary"}`}
        onClick={() => setOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      >
        <I.plus width={13} height={13} />
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(2,4,12,.72)",
            display: "grid",
            placeItems: "center",
            padding: 24,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !saving) setOpen(false);
          }}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              maxHeight: "min(760px, 92vh)",
              overflow: "auto",
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 16,
              boxShadow: "0 24px 80px rgba(0,0,0,.45)",
            }}
          >
            <div style={{ padding: 22, borderBottom: "1px solid rgba(255,255,255,.07)" }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>memory intake</div>
              <h2 style={{ margin: 0, color: "var(--bone)", fontSize: 22 }}>Add company context</h2>
            </div>

            <div style={{ padding: 22, display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em", textTransform: "uppercase" }}>title</span>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Northstar intake packet"
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em", textTransform: "uppercase" }}>type</span>
                <select
                  className="input"
                  value={type}
                  onChange={(e) => setType(e.target.value as Document["type"])}
                >
                  {documentTypes.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label
                style={{
                  display: "grid",
                  gap: 8,
                  padding: 16,
                  borderRadius: 12,
                  border: "1px dashed rgba(255,255,255,.14)",
                  background: "rgba(255,255,255,.02)",
                }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em", textTransform: "uppercase" }}>file</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.markdown,.json,.csv,.tsv,text/plain,text/markdown,application/json,text/csv,text/tab-separated-values"
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                  style={{ color: "var(--mist)" }}
                />
                {fileName && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--pulse)" }}>{fileName}</span>
                )}
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em", textTransform: "uppercase" }}>content</span>
                <textarea
                  className="input"
                  rows={12}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste company overview, ICP, offer, constraints, SOPs, pricing, customer notes, or research."
                  style={{ resize: "vertical", lineHeight: 1.55 }}
                />
              </label>

              {error && (
                <div style={{ color: "var(--ember)", fontSize: 13, background: "rgba(251,146,60,.08)", border: "1px solid rgba(251,146,60,.18)", borderRadius: 10, padding: "10px 12px" }}>
                  {error}
                </div>
              )}
            </div>

            <div style={{ padding: 22, borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button className="btn btn-secondary" onClick={() => setOpen(false)} disabled={saving}>cancel</button>
              <button className="btn btn-pulse" onClick={save} disabled={saving || !content.trim()}>
                {saving ? "saving..." : "save to memory"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
