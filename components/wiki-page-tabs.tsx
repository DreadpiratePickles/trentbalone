"use client";

import { useState } from "react";
import { VaultClient } from "@/components/vault-client";
import { WikiClient } from "@/components/wiki-client";

type WikiTab = "vault" | "trench";

export function WikiPageTabs({ companyId }: { companyId: string }) {
  const [tab, setTab] = useState<WikiTab>("vault");

  return (
    <div>
      <div
        style={{
          display: "inline-flex",
          gap: 4,
          background: "var(--steel)",
          borderRadius: 10,
          padding: 4,
          marginBottom: 24,
        }}
      >
        {([
          { key: "vault" as const, label: "vault notes" },
          { key: "trench" as const, label: "trench wiki" },
        ]).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className="mono"
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: 0,
              background: tab === item.key ? "var(--ink)" : "transparent",
              color: tab === item.key ? "var(--bone)" : "var(--haze)",
              fontSize: 11,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "vault" ? <VaultClient companyId={companyId} /> : <WikiClient companyId={companyId} />}
    </div>
  );
}
