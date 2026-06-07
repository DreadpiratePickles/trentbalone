/**
 * Memory Tiers — T2.5
 *
 * Three memory tiers for Trent's agents:
 *   WorkingMemory  — bounded in-process context for a single cycle/task run
 *   EpisodicMemory — persisted narrative of "what happened" after cycle close
 *   SemanticMemory — persisted structured facts (fact_type, content, source) with supersedes chain
 */

import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { AgentRole, Document } from "@/lib/types";

// ── WorkingMemory ────────────────────────────────────────────────────────────

/** A single entry in the working memory window. */
export type WorkingEntry = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional token estimate for budgeting */
  tokens?: number;
};

/** Soft limit on individual message content before it's trimmed */
const WORKING_MAX_ENTRY_CHARS = 4000;
/** Maximum total entries kept before the window is summarised */
const WORKING_MAX_ENTRIES = 40;

/**
 * WorkingMemory — bounded, in-process context for one cycle or task run.
 *
 * Usage:
 *   const wm = new WorkingMemory();
 *   wm.push("user", "Run the weekly growth report");
 *   const msgs = wm.messages();         // pass to LLM
 *   await wm.close("Summarised: …");    // write summary and free entries
 */
export class WorkingMemory {
  private entries: WorkingEntry[] = [];
  private _summary: string | null = null;

  constructor(
    private readonly label = "cycle",
    private readonly maxEntries = WORKING_MAX_ENTRIES
  ) {}

  /** Append a new message to working memory, trimming oversized content. */
  push(role: WorkingEntry["role"], content: string, tokens?: number) {
    const trimmed =
      content.length > WORKING_MAX_ENTRY_CHARS
        ? content.slice(0, WORKING_MAX_ENTRY_CHARS) + " …[truncated]"
        : content;
    this.entries.push({ role, content: trimmed, tokens });

    // Sliding window: drop oldest non-system entries when over budget
    if (this.entries.length > this.maxEntries) {
      const firstNonSystem = this.entries.findIndex((e) => e.role !== "system");
      if (firstNonSystem >= 0) this.entries.splice(firstNonSystem, 1);
    }
  }

  /** Return the current message list suitable for LLM calls. */
  messages(): WorkingEntry[] {
    return [...this.entries];
  }

  /** Estimated total token count (rough: 1 token ≈ 4 chars). */
  estimatedTokens(): number {
    return this.entries.reduce(
      (sum, e) => sum + (e.tokens ?? Math.ceil(e.content.length / 4)),
      0
    );
  }

  /** Summary produced at close (available after `close()` is called). */
  get summary(): string | null {
    return this._summary;
  }

  /**
   * Finalise working memory.
   * Call this at cycle/task close with a human-readable summary.
   * Clears entries and stores the summary string for downstream use.
   */
  close(summary: string) {
    this._summary = summary;
    this.entries = [];
  }

  toJSON() {
    return {
      label: this.label,
      entryCount: this.entries.length,
      estimatedTokens: this.estimatedTokens(),
      summary: this._summary,
    };
  }
}

// ── EpisodicMemory ───────────────────────────────────────────────────────────

export type EpisodicEvent = {
  /** What happened — narrative sentence */
  what: string;
  /** Which agent role did it */
  agentRole?: AgentRole;
  /** Did it succeed? */
  success: boolean;
  /** Any key metric or number to preserve */
  metric?: string;
};

/**
 * EpisodicMemory — writes a structured narrative to the Document store
 * at cycle close.  Documents are tagged `memoryTier: "episodic"`.
 *
 * Usage:
 *   const em = new EpisodicMemory(companyId, cycleId, "manual");
 *   em.record({ what: "Growth agent ran A/B test on homepage CTA", agentRole: "growth", success: true });
 *   await em.flush();   // called automatically at cycle close via writeEpisodicMemory()
 */
export class EpisodicMemory {
  private events: EpisodicEvent[] = [];

  constructor(
    private readonly companyId: string,
    private readonly cycleId: string,
    private readonly trigger: "manual" | "scheduled"
  ) {}

  /** Record a discrete episode during the cycle. */
  record(event: EpisodicEvent) {
    this.events.push(event);
  }

  /** Build the narrative content block. */
  private buildContent(): string {
    if (this.events.length === 0) return "No episodes recorded.";
    const lines = this.events.map((e) => {
      const status = e.success ? "✓" : "✗";
      const agent = e.agentRole ? `[${e.agentRole.toUpperCase()}] ` : "";
      const metric = e.metric ? ` (${e.metric})` : "";
      return `${status} ${agent}${e.what}${metric}`;
    });
    return lines.join("\n");
  }

  /**
   * Flush recorded episodes to persistent memory as an `agent_note` document.
   * Safe to call even if no events were recorded (writes a minimal stub).
   */
  async flush(): Promise<Document> {
    const now = nowIso();
    const successCount = this.events.filter((e) => e.success).length;
    const title = `Cycle ${this.cycleId} — episodic memory (${this.trigger}, ${successCount}/${this.events.length} ok)`;
    return store.createDocument({
      companyId: this.companyId,
      type: "agent_note",
      title,
      content: this.buildContent(),
      source: `cycle:${this.cycleId}`,
      memoryTier: "episodic",
      validFrom: now,
    });
  }
}

// ── SemanticMemory ───────────────────────────────────────────────────────────

/** A structured fact to write into semantic memory. */
export type SemanticFact = {
  /** Category of fact, e.g. "churn_rate", "mrr", "competitor_pricing" */
  factType: string;
  /** Human-readable content, e.g. "MRR is $82,400 as of May 2025" */
  content: string;
  /** Source reference, e.g. "cycle:cycle_abc123" or "stripe:invoice_list" */
  source: string;
  /** If set, marks the previous document with this id as superseded */
  supersedesId?: string;
};

/**
 * SemanticMemory — writes structured, queryable facts into the Document store.
 * Each fact is a document tagged `memoryTier: "semantic"`.
 * When a fact supersedes an older one, the old document gets `validTo = now`.
 *
 * Usage:
 *   const sm = new SemanticMemory(companyId);
 *   sm.add({ factType: "mrr", content: "$82k MRR (+18% MoM)", source: "cycle:abc" });
 *   await sm.flush();
 */
export class SemanticMemory {
  private facts: SemanticFact[] = [];

  constructor(private readonly companyId: string) {}

  /** Stage a fact for writing. */
  add(fact: SemanticFact) {
    this.facts.push(fact);
  }

  /**
   * Write all staged facts to persistent memory.
   * For each fact that specifies a `supersedesId`, the old document is expired
   * by setting its `validTo` to now (via a document update with a content note).
   */
  async flush(): Promise<Document[]> {
    const now = nowIso();
    const written: Document[] = [];

    for (const fact of this.facts) {
      // Expire the old document if superseding
      if (fact.supersedesId) {
        await expireDocument(fact.supersedesId, now).catch(() => {});
      }

      const doc = await store.createDocument({
        companyId: this.companyId,
        type: "agent_note",
        title: `[semantic] ${fact.factType}`,
        content: fact.content,
        source: fact.source,
        memoryTier: "semantic",
        validFrom: now,
        supersedesId: fact.supersedesId,
      });
      written.push(doc);
    }

    this.facts = [];
    return written;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Expire a Document by setting its validTo timestamp. */
async function expireDocument(id: string, validToIso: string): Promise<void> {
  await store.expireDocument(id, validToIso);
}

// ── Convenience hook for cycle close ────────────────────────────────────────

/**
 * writeEpisodicMemory — call this at the end of runCompanyCycle().
 * Accepts the plan summary + per-agent results and writes one episodic note.
 */
export async function writeEpisodicMemory(opts: {
  companyId: string;
  cycleId: string;
  trigger: "manual" | "scheduled";
  summary: string;
  agentResults: Array<{
    role: AgentRole;
    success: boolean;
    summary?: string;
  }>;
}): Promise<void> {
  const em = new EpisodicMemory(opts.companyId, opts.cycleId, opts.trigger);

  // Record the cycle-level summary
  em.record({
    what: opts.summary,
    success: opts.agentResults.every((r) => r.success),
  });

  // Record per-agent results
  for (const r of opts.agentResults) {
    em.record({
      what: r.summary ?? `${r.role} agent run`,
      agentRole: r.role,
      success: r.success,
    });
  }

  await em.flush();
}
