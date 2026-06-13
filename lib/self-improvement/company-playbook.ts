/**
 * ACE CompanyPlaybook — orchestration guide Task 3.2.
 *
 * The playbook is the company's learned operating rules, grown from run
 * reflections. ACE discipline (the key constraint): it is APPEND-ONLY.
 * Reflections emit bullet DELTAS (`add` / `revise` / `deprecate`) — never a
 * rewrite of the playbook text — and the current playbook is rendered by
 * FOLDING deltas (latest-wins per topic) under a token budget. Rewriting a
 * summary silently drops detail ("context collapse"); folding never does.
 *
 * Modeled on iteration-log.ts: pure builders + a minimal repository
 * interface, in-memory impl for dev/tests, Prisma impl at the edge in
 * company-playbook.prisma.ts. Injection into seat prompts rides the existing
 * SKILL_INJECTION_ENABLED flag (default off).
 */
import { makeId, nowIso } from "@/lib/utils";

export type PlaybookDeltaKind = "add" | "revise" | "deprecate";
export type PlaybookEntryStatus = "active" | "deprecated";

export type CompanyPlaybookEntry = {
  id: string;
  companyId: string;
  kind: PlaybookDeltaKind;
  /** Latest-wins folding key, e.g. "outreach.tone" or "deploys.window". */
  topic: string;
  /** The bullet text. Empty for kind="deprecate" (the delta removes the topic). */
  text: string;
  /** Run that produced the reflection this delta came from. */
  sourceRunId?: string;
  /** "deprecated" rows are auto-demoted deltas — excluded from folding entirely. */
  status: PlaybookEntryStatus;
  createdAt: string;
};

export type AppendPlaybookDeltaInput = Omit<CompanyPlaybookEntry, "id" | "createdAt" | "status"> & {
  id?: string;
  status?: PlaybookEntryStatus;
  now?: string;
};

/** Build a normalized delta row (pure — no I/O). */
export function buildPlaybookDelta(input: AppendPlaybookDeltaInput): CompanyPlaybookEntry {
  return {
    id: input.id ?? makeId("pbd"),
    companyId: input.companyId,
    kind: input.kind,
    topic: input.topic.trim(),
    text: input.text.trim(),
    sourceRunId: input.sourceRunId,
    status: input.status ?? "active",
    createdAt: input.now ?? nowIso(),
  };
}

/** Minimal repository contract — append-only plus a status flip for demotion. */
export interface CompanyPlaybookLog {
  append(entry: CompanyPlaybookEntry): Promise<void>;
  /** All deltas for a company, OLDEST first (fold order). */
  list(companyId: string): Promise<CompanyPlaybookEntry[]>;
  /** Demotion is the only mutation: flip an entry to deprecated. */
  setStatus(companyId: string, entryId: string, status: PlaybookEntryStatus): Promise<void>;
}

/** In-memory implementation for local dev and tests. */
export class InMemoryCompanyPlaybookLog implements CompanyPlaybookLog {
  private entries: CompanyPlaybookEntry[] = [];

  async append(entry: CompanyPlaybookEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  async list(companyId: string): Promise<CompanyPlaybookEntry[]> {
    return this.entries
      .filter((entry) => entry.companyId === companyId)
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async setStatus(companyId: string, entryId: string, status: PlaybookEntryStatus): Promise<void> {
    const entry = this.entries.find((item) => item.companyId === companyId && item.id === entryId);
    if (entry) entry.status = status;
  }
}

export type FoldedPlaybookBullet = {
  topic: string;
  text: string;
  entryId: string;
};

export type FoldedPlaybook = {
  bullets: FoldedPlaybookBullet[];
  /** True when the token budget cut bullets (oldest-changed dropped first). */
  truncated: boolean;
};

const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Fold deltas into the current playbook: latest-wins per topic, deprecated
 * rows (auto-demoted) skipped, `deprecate` deltas remove their topic. Bullets
 * render most-recently-changed first and are capped by token budget.
 */
export function foldPlaybook(
  entries: CompanyPlaybookEntry[],
  options?: { tokenBudget?: number },
): FoldedPlaybook {
  const ordered = entries.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byTopic = new Map<string, CompanyPlaybookEntry>();
  for (const entry of ordered) {
    if (entry.status === "deprecated") continue;
    if (!entry.topic) continue;
    if (entry.kind === "deprecate") byTopic.delete(entry.topic);
    else byTopic.set(entry.topic, entry);
  }

  const newestFirst = [...byTopic.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const budgetChars = (options?.tokenBudget ?? 800) * APPROX_CHARS_PER_TOKEN;
  const bullets: FoldedPlaybookBullet[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of newestFirst) {
    const line = `${entry.topic}: ${entry.text}`;
    if (used + line.length > budgetChars) {
      truncated = true;
      break;
    }
    used += line.length;
    bullets.push({ topic: entry.topic, text: entry.text, entryId: entry.id });
  }
  return { bullets, truncated };
}

/** Render the folded playbook as a seat-prompt block ("" when empty). */
export function renderPlaybookBlock(folded: FoldedPlaybook): string {
  if (!folded.bullets.length) return "";
  return [
    "COMPANY PLAYBOOK (learned operating rules — follow unless the task says otherwise):",
    ...folded.bullets.map((bullet) => `- ${bullet.topic}: ${bullet.text}`),
    folded.truncated ? "(playbook truncated to budget — older rules omitted)" : "",
  ].filter(Boolean).join("\n");
}

export type PlaybookDeltaFitness = {
  entryId: string;
  /** Runs whose seat prompts included this delta. */
  runsWithDelta: number;
  /** Of those, runs where the critic flagged failures (retry/replan/escalate). */
  criticFailures: number;
};

/**
 * Auto-demotion selector: a delta that correlates with critic failures gets
 * deprecated. Pure — the caller supplies fitness stats (from trace data) and
 * applies the returned ids via CompanyPlaybookLog.setStatus.
 */
export function selectDeltasToDemote(
  stats: PlaybookDeltaFitness[],
  options?: { minRuns?: number; failureRate?: number },
): string[] {
  const minRuns = options?.minRuns ?? 3;
  const failureRate = options?.failureRate ?? 0.5;
  return stats
    .filter((stat) => stat.runsWithDelta >= minRuns && stat.criticFailures / stat.runsWithDelta >= failureRate)
    .map((stat) => stat.entryId);
}

/**
 * Map a run reflection's lessons into appendable deltas. Used where
 * goal-reflection completes; pure so reflections stay decoupled from storage.
 */
export function playbookDeltasFromReflection(input: {
  companyId: string;
  sourceRunId?: string;
  lessons: Array<{ topic: string; text: string; kind?: PlaybookDeltaKind }>;
  now?: string;
}): CompanyPlaybookEntry[] {
  return input.lessons
    .filter((lesson) => lesson.topic.trim() && (lesson.kind === "deprecate" || lesson.text.trim()))
    .map((lesson) => buildPlaybookDelta({
      companyId: input.companyId,
      kind: lesson.kind ?? "add",
      topic: lesson.topic,
      text: lesson.text,
      sourceRunId: input.sourceRunId,
      now: input.now,
    }));
}
