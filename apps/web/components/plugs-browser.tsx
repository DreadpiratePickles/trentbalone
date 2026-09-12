"use client";

import { useEffect, useState } from "react";
import type { PlugDefinition } from "@/lib/plug/schema-v2";
import { Eyebrow, Pill } from "@/components/ui";
import { readApiError } from "@/lib/read-api-error";

type PlugDetail = {
  plug: PlugDefinition;
  security?: { status?: string; findings?: string[] };
  ranking?: { marketplaceScore?: number };
  related?: PlugDefinition[];
};

export function PlugsBrowser({ companyId }: { companyId: string }) {
  const [plugs, setPlugs] = useState<PlugDefinition[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlugDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/plugs?companyId=${companyId}`);
        if (!res.ok) {
          if (!cancelled) setError(await readApiError(res));
          return;
        }
        const data = await res.json() as { plugs: PlugDefinition[] };
        if (!cancelled) {
          setPlugs(data.plugs ?? []);
          if (data.plugs?.[0]) setSelectedSlug(data.plugs[0].slug);
        }
      } catch {
        if (!cancelled) setError("Failed to load plugs catalog.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [companyId]);

  useEffect(() => {
    if (!selectedSlug) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/plugs/${selectedSlug}?companyId=${companyId}`);
        if (!res.ok) {
          if (!cancelled) setDetail(null);
          return;
        }
        const data = await res.json() as PlugDetail;
        if (!cancelled) setDetail(data);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => { cancelled = true; };
  }, [companyId, selectedSlug]);

  if (loading) {
    return <p className="mono" style={{ fontSize: 12, color: "var(--haze)", marginTop: 24 }}>loading plugs…</p>;
  }

  if (error) {
    return <p style={{ fontSize: 13, color: "var(--danger)", marginTop: 24 }}>{error}</p>;
  }

  if (plugs.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--mist)", marginTop: 24 }}>No plugs available for this company.</p>;
  }

  return (
    <section style={{ marginTop: 32 }}>
      <Eyebrow style={{ marginBottom: 16 }}>plugs catalog</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 280px) 1fr", gap: 20 }}>
        <div className="card" style={{ maxHeight: 420, overflowY: "auto" }}>
          {plugs.map((plug) => (
            <button
              key={plug.slug}
              type="button"
              onClick={() => setSelectedSlug(plug.slug)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                marginBottom: 6,
                borderRadius: 8,
                border: selectedSlug === plug.slug ? "1px solid rgba(110,231,183,.35)" : "1px solid rgba(255,255,255,.06)",
                background: selectedSlug === plug.slug ? "rgba(110,231,183,.06)" : "transparent",
                color: "var(--mist)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{plug.name}</div>
              <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 4 }}>
                {plug.category} · v{plug.version}
              </div>
            </button>
          ))}
        </div>

        <div className="card">
          {detailLoading || !detail ? (
            <p className="mono" style={{ fontSize: 12, color: "var(--haze)" }}>{detailLoading ? "loading…" : "select a plug"}</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 18, color: "var(--bone)" }}>{detail.plug.name}</h3>
                <Pill tone="pulse">{detail.plug.category}</Pill>
              </div>
              <p className="mono" style={{ fontSize: 11, color: "var(--haze)", marginBottom: 12 }}>
                {detail.plug.slug} · {detail.plug.industry} · {detail.plug.pricing.mode}
              </p>
              <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.5 }}>
                {detail.plug.seats.length} seats · {detail.plug.declaredTools.length} tools ·
                {" "}{Math.round(detail.plug.completionRate * 100)}% completion
              </p>
              {detail.security?.status && (
                <p className="mono" style={{ fontSize: 10, color: "var(--pulse)", marginTop: 10 }}>
                  security: {detail.security.status}
                </p>
              )}
              {detail.related && detail.related.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <Eyebrow style={{ marginBottom: 8 }}>related</Eyebrow>
                  {detail.related.map((r) => (
                    <button
                      key={r.slug}
                      type="button"
                      className="btn btn-secondary btn-mono"
                      style={{ marginRight: 8, marginBottom: 8, fontSize: 10 }}
                      onClick={() => setSelectedSlug(r.slug)}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
