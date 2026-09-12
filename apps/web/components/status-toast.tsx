"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ToastTone = "error" | "info";
type ToastItem = { id: string; message: string; tone: ToastTone };

type ToastContextValue = {
  pushToast: (message: string, tone?: ToastTone) => void;
  pushError: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function StatusToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev.slice(-4), { id, message, tone }]);
    window.setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);

  const pushError = useCallback((message: string) => pushToast(message, "error"), [pushToast]);

  const value = useMemo(() => ({ pushToast, pushError }), [pushToast, pushError]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 200,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxWidth: 420,
          pointerEvents: "none",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            style={{
              pointerEvents: "auto",
              padding: "12px 14px",
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.45,
              color: "var(--bone)",
              background: toast.tone === "error" ? "rgba(251,146,60,.95)" : "rgba(20,20,28,.95)",
              border:
                toast.tone === "error"
                  ? "1px solid rgba(251,146,60,.5)"
                  : "1px solid rgba(255,255,255,.12)",
              boxShadow: "0 8px 32px rgba(0,0,0,.35)",
            }}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useStatusToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useStatusToast must be used within StatusToastProvider");
  return ctx;
}
