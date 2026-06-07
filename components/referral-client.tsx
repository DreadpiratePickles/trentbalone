"use client";

import { useState, useEffect } from "react";
import { PageHeader, Eyebrow, Pill, I } from "@/components/ui";

interface ReferralData {
  code: string;
  link: string;
  referrals: Array<{ email: string; status: string; creditCents: number }>;
  pendingCount: number;
  convertedCount: number;
  creditEarnedCents: number;
  creditPerReferralCents: number;
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(0)}`;
}

export function ReferralPageClient({
  userId,
  userEmail,
}: {
  userId: string | null;
  userEmail: string | null;
}) {
  const [data, setData] = useState<ReferralData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!userId && !userEmail) {
      setLoading(false);
      return;
    }
    fetch("/api/referral")
      .then((r) => r.json())
      .then((d: ReferralData) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId, userEmail]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text manually
    }
  };

  if (!userId && !userEmail) {
    return (
      <div>
        <PageHeader eyebrow="referral" title="Refer a founder." lead="Sign in to get your referral link." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="referral"
        title="Refer a founder."
        lead="Get $99 in Trent credit for every founder you refer who starts a paid plan."
      />

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel" style={{ height: 120, borderRadius: 12 }} />
          ))}
        </div>
      ) : data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 720 }}>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            <StatCard
              label="credit earned"
              value={money(data.creditEarnedCents)}
              tone={data.creditEarnedCents > 0 ? "pulse" : "haze"}
              sub="applied to next invoice"
            />
            <StatCard
              label="converted"
              value={String(data.convertedCount)}
              tone={data.convertedCount > 0 ? "pulse" : "haze"}
              sub="paying referrals"
            />
            <StatCard
              label="pending"
              value={String(data.pendingCount)}
              tone="haze"
              sub="signed up, not yet paid"
            />
          </div>

          {/* Link card */}
          <div
            style={{
              padding: 28,
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 16,
            }}
          >
            <Eyebrow style={{ marginBottom: 16 }}>your referral link</Eyebrow>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "var(--steel)",
                border: "1px solid rgba(255,255,255,.06)",
                borderRadius: 10,
                padding: "12px 16px",
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  color: "var(--bone)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {data.link}
              </span>
              <button
                onClick={copy}
                className="btn btn-mono"
                style={{
                  height: 32,
                  padding: "0 14px",
                  background: copied ? "rgba(110,231,183,.12)" : "var(--slate)",
                  border: copied ? "1px solid rgba(110,231,183,.3)" : "1px solid rgba(255,255,255,.08)",
                  color: copied ? "var(--pulse)" : "var(--bone)",
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  letterSpacing: ".12em",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "all .2s",
                }}
              >
                {copied ? "✓ copied" : "copy"}
              </button>
            </div>
            <p
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--haze)",
                marginTop: 12,
                letterSpacing: ".12em",
              }}
            >
              CODE · {data.code} · {money(data.creditPerReferralCents)} per conversion
            </p>
          </div>

          {/* How it works */}
          <div
            style={{
              padding: 28,
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 16,
            }}
          >
            <Eyebrow style={{ marginBottom: 20 }}>how it works</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { n: "01", title: "Share your link", body: "Send it to a founder who needs an AI cofounder." },
                { n: "02", title: "They start a free trial", body: "They sign up using your link — no credit card required." },
                { n: "03", title: "They go paid", body: "When they start a paid Operator or Studio plan, you earn $99 credit." },
                { n: "04", title: "Credit applied automatically", body: "Credit is applied to your next Trent invoice. No redemption needed." },
              ].map((step) => (
                <div key={step.n} style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--pulse)",
                      letterSpacing: ".16em",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    {step.n}
                  </span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--bone)", marginBottom: 4 }}>
                      {step.title}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.5 }}>{step.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Referrals table */}
          <div
            style={{
              padding: 28,
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 16,
            }}
          >
            <Eyebrow style={{ marginBottom: 20 }}>your referrals</Eyebrow>
            {data.referrals.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <I.sparkle style={{ color: "var(--haze)", marginBottom: 12 }} />
                <p style={{ fontSize: 14, color: "var(--mist)", lineHeight: 1.6 }}>
                  No referrals yet. Share your link to get started.
                  <br />
                  <span style={{ color: "var(--haze)", fontSize: 13 }}>Trent&apos;s got it.</span>
                </p>
              </div>
            ) : (
              <div>
                {data.referrals.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto auto",
                      gap: 16,
                      alignItems: "center",
                      padding: "12px 0",
                      borderBottom: "1px solid rgba(255,255,255,.05)",
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--bone)" }}>{r.email}</span>
                    <Pill tone={r.status === "converted" ? "pulse" : "neutral"}>{r.status}</Pill>
                    <span
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: r.creditCents > 0 ? "var(--pulse)" : "var(--haze)",
                      }}
                    >
                      {r.creditCents > 0 ? `+${money(r.creditCents)}` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 14, color: "var(--mist)" }}>Unable to load referral data.</p>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "pulse" | "ember" | "haze";
  sub?: string;
}) {
  const colors = { pulse: "var(--pulse)", ember: "var(--ember)", haze: "var(--bone)" };
  return (
    <div
      style={{
        padding: 24,
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.08)",
        borderRadius: 14,
      }}
    >
      <Eyebrow style={{ marginBottom: 12 }}>{label}</Eyebrow>
      <div
        style={{
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: "-.03em",
          color: colors[tone],
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--haze)", marginTop: 8, letterSpacing: ".1em" }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
