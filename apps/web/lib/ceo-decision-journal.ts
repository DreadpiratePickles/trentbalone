import type { Document } from "@/lib/types";
import type { OrchestrationRun } from "@/lib/orchestrator";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";

type SuggestionLike = {
  title?: string;
  rationale?: string;
  priority?: string;
};

export async function persistCeoDecisionJournal(
  run: OrchestrationRun,
  suggestions: SuggestionLike[] = [],
): Promise<Document> {
  return store.createDocument({
    companyId: run.companyId,
    type: "agent_note",
    title: `CEO decision journal: ${run.objective.slice(0, 120)}`,
    content: buildCeoDecisionJournalContent(run, suggestions),
    source: `ceo-decision-journal:${run.id}`,
    memoryTier: "semantic",
    validFrom: run.completedAt ?? nowIso(),
  });
}

export function buildCeoDecisionJournalContent(run: OrchestrationRun, suggestions: SuggestionLike[] = []) {
  const ceoSteps = run.steps.filter((step) => step.agentRole === "ceo");
  return [
    "# CEO Decision Journal",
    "",
    `Run: ${run.id}`,
    `Objective: ${run.objective}`,
    `Status: ${run.status}`,
    `Trigger: ${run.trigger}`,
    `Completed At: ${run.completedAt ?? "(not completed)"}`,
    "",
    "## Rationale",
    run.summary || "No CEO summary recorded.",
    "",
    "## CEO Step Outputs",
    ceoSteps.length
      ? ceoSteps.map((step) => `- ${step.title}: ${(step.output ?? step.handoff?.summary ?? "").slice(0, 500)}`).join("\n")
      : "No dedicated CEO step output recorded.",
    "",
    "## Next Decisions",
    suggestions.length
      ? suggestions.map((suggestion) => [
          `- ${suggestion.title ?? "Untitled decision"}`,
          suggestion.priority ? `  - priority: ${suggestion.priority}` : undefined,
          suggestion.rationale ? `  - rationale: ${suggestion.rationale}` : undefined,
        ].filter(Boolean).join("\n")).join("\n")
      : "No follow-up decisions recorded.",
  ].join("\n");
}
