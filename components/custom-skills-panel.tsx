"use client";

/**
 * Custom Skills panel (§3.2) — the client authoring surface in Settings.
 * Instruction-style skills (markdown procedures, brand rules, "how we qualify
 * leads") that flow into every seat prompt through the same prelude path as
 * granted/distilled skills. Instruction-only — no client code to sandbox.
 */

import { useCallback, useEffect, useState } from "react";

type CustomSkill = {
  id: string;
  name: string;
  trigger: string;
  instructions: string;
  enabled: boolean;
  updatedAt: string;
};

const emptyDraft = { name: "", trigger: "", instructions: "" };

export function CustomSkillsPanel({ companyId }: { companyId: string }) {
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/skills`);
    const data = await res.json().catch(() => ({}));
    setSkills(data.skills ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  function openNew() {
    setDraft(emptyDraft);
    setEditing("new");
    setError("");
  }

  function openEdit(skill: CustomSkill) {
    setDraft({ name: skill.name, trigger: skill.trigger, instructions: skill.instructions });
    setEditing(skill.id);
    setError("");
  }

  async function save() {
    if (!draft.name.trim() || !draft.instructions.trim()) {
      setError("Name and instructions are required.");
      return;
    }
    setSaving(true);
    setError("");
    const isNew = editing === "new";
    const res = await fetch(
      isNew ? `/api/companies/${companyId}/skills` : `/api/companies/${companyId}/skills/${editing}`,
      {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      },
    );
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Save failed.");
      return;
    }
    setEditing(null);
    await load();
  }

  async function toggle(skill: CustomSkill) {
    await fetch(`/api/companies/${companyId}/skills/${skill.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !skill.enabled }),
    });
    await load();
  }

  async function remove(skillId: string) {
    await fetch(`/api/companies/${companyId}/skills/${skillId}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="card" data-testid="custom-skills-panel" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, color: "var(--bone)" }}>Custom skills</div>
          <div style={{ fontSize: 12, color: "var(--haze)", marginTop: 4, lineHeight: 1.5 }}>
            Instruction-style procedures your agents follow on every relevant task — brand rules,
            qualification playbooks, how-we-do-things. Injected into seat prompts automatically.
          </div>
        </div>
        <button
          className="btn btn-secondary btn-mono"
          data-testid="custom-skill-add-button"
          style={{ height: 30, padding: "0 12px", fontSize: 10, whiteSpace: "nowrap" }}
          onClick={openNew}
        >
          + add skill
        </button>
      </div>

      {loading ? (
        <div className="skel" style={{ height: 60, borderRadius: 10, marginTop: 12 }} />
      ) : skills.length === 0 && editing === null ? (
        <div data-testid="custom-skills-empty" style={{ fontSize: 12, color: "var(--haze)", padding: "16px 0" }}>
          No custom skills yet. Add your first procedure — e.g. “How we qualify leads”.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {skills.map((skill) => (
            <div
              key={skill.id}
              data-testid={`custom-skill-row-${skill.id}`}
              style={{
                border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "12px 14px",
                display: "flex", alignItems: "flex-start", gap: 12,
                opacity: skill.enabled ? 1 : 0.55,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)" }}>{skill.name}</div>
                {skill.trigger && (
                  <div className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".06em", marginTop: 2 }}>
                    trigger: {skill.trigger}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--mist)", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 60, overflow: "hidden" }}>
                  {skill.instructions.slice(0, 220)}{skill.instructions.length > 220 ? "…" : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  className="btn btn-secondary btn-mono"
                  data-testid={`custom-skill-toggle-${skill.id}`}
                  style={{ height: 26, padding: "0 10px", fontSize: 9 }}
                  onClick={() => toggle(skill)}
                >
                  {skill.enabled ? "on" : "off"}
                </button>
                <button
                  className="btn btn-secondary btn-mono"
                  data-testid={`custom-skill-edit-${skill.id}`}
                  style={{ height: 26, padding: "0 10px", fontSize: 9 }}
                  onClick={() => openEdit(skill)}
                >
                  edit
                </button>
                <button
                  className="btn btn-secondary btn-mono"
                  data-testid={`custom-skill-delete-${skill.id}`}
                  style={{ height: 26, padding: "0 10px", fontSize: 9, color: "var(--ember)", borderColor: "rgba(251,146,60,.2)" }}
                  onClick={() => remove(skill.id)}
                >
                  delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <div
          data-testid="custom-skill-editor"
          style={{ marginTop: 14, border: "1px solid rgba(110,231,183,.15)", borderRadius: 12, padding: 16 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              className="input"
              data-testid="custom-skill-name-input"
              placeholder="Skill name — e.g. How we qualify leads"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              className="input"
              data-testid="custom-skill-trigger-input"
              placeholder="Trigger keywords (optional) — e.g. sales outreach lead"
              value={draft.trigger}
              onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
            />
            <textarea
              className="input"
              data-testid="custom-skill-instructions-input"
              placeholder={"Markdown instructions the agents must follow…\n1. Always check the ICP fit first\n2. …"}
              rows={6}
              style={{ resize: "vertical", lineHeight: 1.5 }}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
            {error && (
              <div data-testid="custom-skill-error" style={{ fontSize: 12, color: "var(--ember)" }}>{error}</div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary btn-mono" style={{ fontSize: 10 }} onClick={() => setEditing(null)}>
                cancel
              </button>
              <button
                className="btn btn-pulse btn-mono"
                data-testid="custom-skill-save-button"
                style={{ marginLeft: "auto", fontSize: 10 }}
                onClick={save}
                disabled={saving}
              >
                {saving ? "saving…" : editing === "new" ? "create skill" : "save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
