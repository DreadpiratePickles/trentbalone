"use client";

import { useEffect, useState } from "react";
import type { Invoice, LedgerEntry, PayoutHold, UsageLedgerEntry } from "@/lib/types";
import { Eyebrow } from "@/components/ui";
import { money, shortDate } from "@/lib/utils";
import { readApiError } from "@/lib/read-api-error";

type BillingUsage = {
  billingPeriod: string;
  totalCents: number;
  items: UsageLedgerEntry[];
};

export function BillingDetailPanel({ companyId }: { companyId: string }) {
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [holds, setHolds] = useState<PayoutHold[]>([]);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [historyRes, invoicesRes, holdsRes, usageRes] = await Promise.all([
          fetch(`/api/companies/${companyId}/billing/history`),
          fetch(`/api/companies/${companyId}/billing/invoices`),
          fetch(`/api/companies/${companyId}/billing/holds`),
          fetch(`/api/companies/${companyId}/billing/usage`),
        ]);
        if (!historyRes.ok || !invoicesRes.ok || !holdsRes.ok || !usageRes.ok) {
          const failed = [historyRes, invoicesRes, holdsRes, usageRes].find((r) => !r.ok);
          if (!cancelled && failed) setError(await readApiError(failed));
          return;
        }
        const [historyData, invoicesData, holdsData, usageData] = await Promise.all([
          historyRes.json(),
          invoicesRes.json(),
          holdsRes.json(),
          usageRes.json(),
        ]);
        if (cancelled) return;
        setHistory(historyData.ledgerEntries ?? []);
        setInvoices(invoicesData.invoices ?? []);
        setHolds(holdsData.holds ?? []);
        setUsage(usageData as BillingUsage);
      } catch {
        if (!cancelled) setError("Failed to load billing details.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [companyId]);

  if (loading) {
    return <p className="mono" style={{ fontSize: 12, color: "var(--haze)", marginTop: 24 }}>loading billing records…</p>;
  }

  if (error) {
    return <p style={{ fontSize: 13, color: "var(--danger)", marginTop: 24 }}>{error}</p>;
  }

  const empty = history.length === 0 && invoices.length === 0 && holds.length === 0 && !usage?.totalCents;

  return (
    <section style={{ marginTop: 32 }}>
      <Eyebrow style={{ marginBottom: 16 }}>billing detail</Eyebrow>
      {empty ? (
        <p style={{ fontSize: 13, color: "var(--mist)" }}>No invoices, ledger entries, or holds yet.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          <div className="card">
            <Eyebrow style={{ marginBottom: 12 }}>unbilled usage</Eyebrow>
            {usage ? (
              <>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--bone)" }}>{money(usage.totalCents)}</div>
                <p className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 6 }}>{usage.billingPeriod}</p>
                {(usage.items ?? []).slice(0, 5).map((item) => (
                  <div key={item.id} style={{ fontSize: 12, color: "var(--mist)", marginTop: 8 }}>
                    {item.description} · {money(item.amountCents)}
                  </div>
                ))}
              </>
            ) : (
              <p style={{ fontSize: 13, color: "var(--haze)" }}>No unbilled usage.</p>
            )}
          </div>

          <div className="card">
            <Eyebrow style={{ marginBottom: 12 }}>invoices ({invoices.length})</Eyebrow>
            {invoices.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--haze)" }}>No invoices issued.</p>
            ) : (
              invoices.slice(0, 6).map((inv) => (
                <div key={inv.id} style={{ fontSize: 12, color: "var(--mist)", marginBottom: 8 }}>
                  {inv.id.slice(0, 8)} · {money(inv.amountCents)} · {inv.status} · {shortDate(inv.createdAt)}
                </div>
              ))
            )}
          </div>

          <div className="card">
            <Eyebrow style={{ marginBottom: 12 }}>ledger ({history.length})</Eyebrow>
            {history.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--haze)" }}>No ledger entries.</p>
            ) : (
              history.slice(0, 6).map((entry) => (
                <div key={entry.id} style={{ fontSize: 12, color: "var(--mist)", marginBottom: 8 }}>
                  {entry.type}/{entry.account} · {money(entry.amountCents)} · {shortDate(entry.createdAt)}
                </div>
              ))
            )}
          </div>

          <div className="card">
            <Eyebrow style={{ marginBottom: 12 }}>holds ({holds.length})</Eyebrow>
            {holds.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--haze)" }}>No active payout holds.</p>
            ) : (
              holds.map((hold) => (
                <div key={hold.id} style={{ fontSize: 12, color: "var(--ember)", marginBottom: 8 }}>
                  {hold.reason} · {money(hold.amountCents)} · {hold.status}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
