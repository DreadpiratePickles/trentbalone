"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
  MutableRefObject,
} from "react";

// Lenis-style inertial scrolling: native scroll drives a lerped "eased" value,
// and the page content (a fixed wrapper) is translated by that eased value.
// Native scrollbar, keyboard, and anchor navigation keep working — only the
// painted position is smoothed.

type EasedScrollRef = MutableRefObject<number>;

const EasedScrollContext = createContext<EasedScrollRef | null>(null);

/** Eased scroll position ref (falls back to native scrollY outside the provider). */
export function useEasedScrollRef(): EasedScrollRef | null {
  return useContext(EasedScrollContext);
}

const LERP = 0.085;

export function SmoothScroll({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const eased = useRef(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (reduced || coarse) return; // native scroll on touch / reduced motion

    setActive(true);
    eased.current = window.scrollY;

    const content = contentRef.current;
    const spacer = spacerRef.current;
    if (!content || !spacer) return;

    const syncHeight = () => {
      spacer.style.height = `${content.scrollHeight}px`;
    };
    syncHeight();
    const ro = new ResizeObserver(syncHeight);
    ro.observe(content);

    let raf = 0;
    const tick = () => {
      const target = window.scrollY;
      const delta = target - eased.current;
      eased.current = Math.abs(delta) < 0.05 ? target : eased.current + delta * LERP;
      content.style.transform = `translate3d(0, ${-eased.current}px, 0)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      setActive(false);
    };
  }, []);

  return (
    <EasedScrollContext.Provider value={eased}>
      <div ref={contentRef} className={active ? "hub-smooth-fixed" : undefined}>
        {children}
      </div>
      {/* Keeps the document tall so the native scrollbar still maps the page. */}
      <div ref={spacerRef} aria-hidden style={{ pointerEvents: "none" }} />
    </EasedScrollContext.Provider>
  );
}
