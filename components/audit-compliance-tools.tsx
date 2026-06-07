"use client";

import { useState } from "react";
import { I } from "@/components/ui";
import { readApiError } from "@/lib/read-api-error";

type VerifyResult = { valid: boolean; count: number; brokenAt?: string };

export function AuditComplianceTools({ companyId }: { companyId: string }) {
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verifyChain() {
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/audit/verify`);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setVerifyResult(await res.json() as VerifyResult);
    } catch {
      setError("Chain verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function exportNdjson() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/audit/export`);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${companyId}-${new Date().toISOString().slice(0, 10)}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => void verifyChain()}
          disabled={verifying}
          className="btn btn-secondary btn-mono"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <I.shield width={13} height={13} />
          {verifying ? "verifying…" : "verify chain"}
        </button>
        <button
          type="button"
          onClick={() => void exportNdjson()}
          disabled={exporting}
          className="btn btn-secondary btn-mono"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <I.doc width={13} height={13} />
          {exporting ? "exporting…" : "export ndjson"}
        </button>
      </div>
      {verifyResult && (
        <span className="mono" style={{ fontSize: 10, color: verifyResult.valid ? "var(--pulse)" : "var(--danger)" }}>
          {verifyResult.valid
            ? `chain valid · ${verifyResult.count} entries`
            : `chain broken at ${verifyResult.brokenAt ?? "?"} · ${verifyResult.count} checked`}
        </span>
      )}
      {error && (
        <span className="mono" style={{ fontSize: 10, color: "var(--danger)" }}>{error}</span>
      )}
    </div>
  );
}
