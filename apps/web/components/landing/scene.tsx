"use client";

import { useEffect, useRef } from "react";
import { useEasedScrollRef } from "./smooth-scroll";

// ── Particle sea ───────────────────────────────────────────────────
// A sparse field of glints drifting toward the camera on a perspective
// plane, with a soft mint horizon glow. Sits fixed behind the page;
// intensity falls away as the visitor scrolls into the content.

type Mote = {
  x: number; // -1..1 across the plane
  z: number; // 0 (camera) .. 1 (horizon)
  speed: number;
  phase: number;
  ember: boolean;
};

const MOTES = 230;

export function ParticleSea() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const easedRef = useEasedScrollRef();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const motes: Mote[] = Array.from({ length: MOTES }, () => ({
      x: Math.random() * 2 - 1,
      z: Math.random(),
      speed: 0.018 + Math.random() * 0.05,
      phase: Math.random() * Math.PI * 2,
      ember: Math.random() < 0.04,
    }));

    let raf = 0;
    let last = performance.now();
    let running = true;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const scroll = easedRef ? easedRef.current : window.scrollY;
      const vh = h || 1;
      // Scene is loudest on the hero, settles to a low hum afterwards.
      const presence = Math.max(0.22, 1 - (scroll / (vh * 1.4)) * 0.78);

      ctx.clearRect(0, 0, w, h);

      const horizonY = h * 0.46 - scroll * 0.04;

      // Horizon glow
      const glow = ctx.createRadialGradient(
        w / 2, horizonY + h * 0.12, 10,
        w / 2, horizonY + h * 0.12, w * 0.55
      );
      glow.addColorStop(0, `rgba(110, 231, 183, ${0.10 * presence})`);
      glow.addColorStop(0.5, `rgba(110, 231, 183, ${0.035 * presence})`);
      glow.addColorStop(1, "rgba(110, 231, 183, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // Motes on the water plane
      for (const m of motes) {
        if (!reduced) {
          m.z -= m.speed * dt;
          if (m.z <= 0.02) {
            m.z = 1;
            m.x = Math.random() * 2 - 1;
            m.ember = Math.random() < 0.04;
          }
        }
        const depth = m.z; // 1 = far, ~0 = near
        const spread = 0.18 + (1 - depth) * 1.15;
        const px = w / 2 + m.x * (w / 2) * spread;
        const bob = reduced ? 0 : Math.sin(now / 900 + m.phase) * (1 - depth) * 3;
        const py = horizonY + (1 - depth) * (h - horizonY) * 0.92 + bob;
        if (py < -10 || py > h + 10) continue;

        const size = 0.6 + (1 - depth) * 2.2;
        const alpha = (0.12 + (1 - depth) * 0.5) * presence;
        ctx.fillStyle = m.ember
          ? `rgba(251, 146, 60, ${alpha})`
          : `rgba(110, 231, 183, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduced && running) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onVisibility = () => {
      running = document.visibilityState === "visible";
      if (running && !reduced) {
        last = performance.now();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [easedRef]);

  return <canvas ref={canvasRef} className="hub-scene" aria-hidden />;
}

// ── Glow cube ──────────────────────────────────────────────────────
// The hero centerpiece: a slowly turning translucent cube in pulse
// mint, hovering over its own pool of light.

export function GlowCube({ size = 120 }: { size?: number }) {
  return (
    <div className="hub-cube-stage" style={{ height: size * 2.2, position: "relative" }}>
      <div className="hub-cube-glow" />
      <div className="hub-cube-bob">
        <div className="hub-cube" style={{ ["--cube" as never]: `${size}px` }}>
          <i /><i /><i /><i /><i /><i />
        </div>
      </div>
    </div>
  );
}
