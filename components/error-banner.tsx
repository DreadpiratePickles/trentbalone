"use client";

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        background: "rgba(251,146,60,.08)",
        border: "1px solid rgba(251,146,60,.35)",
        color: "var(--bone)",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <span style={{ color: "var(--ember)", flexShrink: 0 }}>!</span>
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--haze)",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export const LLM_NOT_CONFIGURED_MESSAGE = "LLM not configured — see docs/RUN.md";

export function LlmNotConfiguredBanner() {
  return <ErrorBanner message={LLM_NOT_CONFIGURED_MESSAGE} />;
}
