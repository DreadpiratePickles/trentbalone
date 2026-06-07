"use client";

import { useEffect, useState } from "react";
import type { BrandVoiceProfile } from "@/lib/brand/voice-memory";
import type { BrandVisualProfile } from "@/lib/brand/visual-memory";
import { Eyebrow } from "@/components/ui";
import { readApiError } from "@/lib/read-api-error";

function linesToArray(text: string) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function arrayToLines(values: string[] | undefined) {
  return (values ?? []).join("\n");
}

export function BrandSettingsPanel({ companyId }: { companyId: string }) {
  const [voiceSamples, setVoiceSamples] = useState("");
  const [voiceProfile, setVoiceProfile] = useState<BrandVoiceProfile | null>(null);
  const [logoUrl, setLogoUrl] = useState("");
  const [palette, setPalette] = useState("");
  const [typography, setTypography] = useState("");
  const [referenceUrls, setReferenceUrls] = useState("");
  const [negativeTerms, setNegativeTerms] = useState("");
  const [visualProfile, setVisualProfile] = useState<BrandVisualProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingVoice, setSavingVoice] = useState(false);
  const [savingVisual, setSavingVisual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceSaved, setVoiceSaved] = useState(false);
  const [visualSaved, setVisualSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [voiceRes, visualRes] = await Promise.all([
          fetch(`/api/brand/voice?companyId=${companyId}`),
          fetch(`/api/brand/visual?companyId=${companyId}`),
        ]);
        if (!voiceRes.ok || !visualRes.ok) {
          const failed = [voiceRes, visualRes].find((r) => !r.ok);
          if (!cancelled && failed) setError(await readApiError(failed));
          return;
        }
        const voiceData = await voiceRes.json() as { profile: BrandVoiceProfile | null };
        const visualData = await visualRes.json() as { profile: BrandVisualProfile | null };
        if (cancelled) return;
        setVoiceProfile(voiceData.profile);
        if (visualData.profile) {
          setVisualProfile(visualData.profile);
          setLogoUrl(visualData.profile.logoUrl ?? "");
          setPalette(arrayToLines(visualData.profile.palette));
          setTypography(arrayToLines(visualData.profile.typography));
          setReferenceUrls(arrayToLines(visualData.profile.referenceImageUrls));
          setNegativeTerms(arrayToLines(visualData.profile.negativeTerms));
        }
      } catch {
        if (!cancelled) setError("Failed to load brand profiles.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [companyId]);

  async function deriveVoice() {
    const samples = linesToArray(voiceSamples);
    if (samples.length === 0) return;
    setSavingVoice(true);
    setError(null);
    setVoiceSaved(false);
    try {
      const res = await fetch("/api/brand/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId, samples }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { profile: BrandVoiceProfile };
      setVoiceProfile(data.profile);
      setVoiceSaved(true);
      setTimeout(() => setVoiceSaved(false), 2000);
    } catch {
      setError("Voice derivation failed.");
    } finally {
      setSavingVoice(false);
    }
  }

  async function saveVisual() {
    setSavingVisual(true);
    setError(null);
    setVisualSaved(false);
    try {
      const res = await fetch("/api/brand/visual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId,
          logoUrl: logoUrl.trim() || undefined,
          palette: linesToArray(palette),
          typography: linesToArray(typography),
          referenceImageUrls: linesToArray(referenceUrls),
          negativeTerms: linesToArray(negativeTerms),
        }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { profile: BrandVisualProfile };
      setVisualProfile(data.profile);
      setVisualSaved(true);
      setTimeout(() => setVisualSaved(false), 2000);
    } catch {
      setError("Visual profile save failed.");
    } finally {
      setSavingVisual(false);
    }
  }

  if (loading) {
    return <p className="mono" style={{ fontSize: 12, color: "var(--haze)" }}>loading brand profiles…</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div>
        <Eyebrow style={{ marginBottom: 12 }}>brand voice</Eyebrow>
        {voiceProfile && (
          <p style={{ fontSize: 12, color: "var(--mist)", marginBottom: 10 }}>
            confidence {voiceProfile.confidence} · {voiceProfile.sampleCount} samples · {voiceProfile.vocabularyStyle}
          </p>
        )}
        <label className="mono" style={{ fontSize: 10, color: "var(--haze)", display: "block", marginBottom: 6 }}>
          writing samples (one per line)
        </label>
        <textarea
          className="input"
          rows={4}
          value={voiceSamples}
          onChange={(e) => setVoiceSamples(e.target.value)}
          placeholder="Paste 1–3 representative paragraphs…"
          style={{ resize: "vertical", width: "100%" }}
        />
        <button
          type="button"
          className="btn btn-primary btn-mono"
          onClick={() => void deriveVoice()}
          disabled={savingVoice || linesToArray(voiceSamples).length === 0}
          style={{ marginTop: 10 }}
        >
          {voiceSaved ? "✓ derived" : savingVoice ? "deriving…" : "derive voice profile"}
        </button>
      </div>

      <div>
        <Eyebrow style={{ marginBottom: 12 }}>visual brand</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input className="input" placeholder="logo URL" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
          <textarea className="input" rows={2} placeholder="palette (one hex per line)" value={palette} onChange={(e) => setPalette(e.target.value)} />
          <textarea className="input" rows={2} placeholder="typography (one font per line)" value={typography} onChange={(e) => setTypography(e.target.value)} />
          <textarea className="input" rows={2} placeholder="reference image URLs" value={referenceUrls} onChange={(e) => setReferenceUrls(e.target.value)} />
          <textarea className="input" rows={2} placeholder="negative terms to avoid" value={negativeTerms} onChange={(e) => setNegativeTerms(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-mono"
          onClick={() => void saveVisual()}
          disabled={savingVisual}
          style={{ marginTop: 10 }}
        >
          {visualSaved ? "✓ saved" : savingVisual ? "saving…" : "save visual profile"}
        </button>
        {visualProfile && (
          <p className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 8 }}>
            updated {visualProfile.updatedAt}
          </p>
        )}
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
