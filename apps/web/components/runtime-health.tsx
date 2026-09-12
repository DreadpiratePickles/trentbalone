"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { HealthReadiness } from "@/lib/health-readiness";

type RuntimeHealthContextValue = {
  readiness: HealthReadiness | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const defaultReadiness: HealthReadiness = {
  ok: false,
  llm: false,
  db: "memory",
  redis: false,
};

const RuntimeHealthContext = createContext<RuntimeHealthContextValue>({
  readiness: null,
  loading: true,
  refresh: async () => {},
});

export function RuntimeHealthProvider({ children }: { children: ReactNode }) {
  const [readiness, setReadiness] = useState<HealthReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) {
        setReadiness(defaultReadiness);
        return;
      }
      const body = (await res.json()) as { readiness?: HealthReadiness };
      setReadiness(body.readiness ?? defaultReadiness);
    } catch {
      setReadiness(defaultReadiness);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const value = useMemo(
    () => ({ readiness, loading, refresh }),
    [readiness, loading, refresh],
  );

  return (
    <RuntimeHealthContext.Provider value={value}>
      {children}
    </RuntimeHealthContext.Provider>
  );
}

export function useRuntimeHealth(): RuntimeHealthContextValue {
  return useContext(RuntimeHealthContext);
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: ok ? "var(--pulse)" : "var(--ember)",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

export function RuntimeHealthChip() {
  const { readiness, loading } = useRuntimeHealth();
  if (loading && !readiness) {
    return (
      <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".08em" }}>
        checking…
      </span>
    );
  }

  const r = readiness ?? defaultReadiness;
  const items: Array<{ label: string; ok: boolean }> = [
    { label: "LLM", ok: r.llm },
    { label: "DB", ok: r.db === "postgres" },
    { label: "Redis", ok: r.redis },
  ];

  return (
    <div
      title={`LLM ${r.llm ? "ok" : "missing"} · DB ${r.db} · Redis ${r.redis ? "ok" : "missing"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 10px",
        borderRadius: 8,
        background: "var(--steel)",
        border: "1px solid rgba(255,255,255,.06)",
      }}
    >
      {items.map((item) => (
        <span
          key={item.label}
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 9,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            color: item.ok ? "var(--mist)" : "var(--ember)",
          }}
        >
          <StatusDot ok={item.ok} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
