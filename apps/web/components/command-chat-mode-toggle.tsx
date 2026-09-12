"use client";

import type { CeoChatMode } from "@/lib/ceo-chat-mode";

export function CommandChatModeToggle({
  mode,
  onModeChange,
}: {
  mode: CeoChatMode;
  onModeChange: (mode: CeoChatMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="chat mode"
      style={{
        display: "inline-flex",
        padding: 3,
        borderRadius: 9,
        background: "rgba(255,255,255,.04)",
        border: "1px solid rgba(255,255,255,.08)",
      }}
    >
      {(["org", "gen"] as const).map((value) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onModeChange(value)}
            style={{
              height: 28,
              minWidth: 42,
              padding: "0 12px",
              borderRadius: 7,
              border: "none",
              background: active ? "rgba(110,231,183,.14)" : "transparent",
              color: active ? "var(--pulse)" : "var(--haze)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}
