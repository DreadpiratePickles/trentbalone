/**
 * Test harness for the REPL engine.
 *
 * The store double here is for the fast in-process tests only. Durability — the
 * approval that survives a restart — is proved against the REAL bun:sqlite store in
 * approvals.restart.test.ts, because a double cannot prove persistence.
 */

import { vi, type Mock } from "vitest";
import { createTheme } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type {
  ApprovalRecord,
  CompanyRecord,
  CreateApprovalInput,
  CreateCompanyInput,
  CreateJobRunInput,
  CreateRunInput,
  EventRecord,
  JobRunRecord,
  RunRecord,
  StepRecord,
  StorePort,
  UpdateRunInput,
  UpsertStepInput,
} from "@trent/core/store/index.js";
import { ReplEngine, PROMPT } from "../engine.js";

// ── in-memory StorePort ─────────────────────────────────────────────────────

export class MemoryStore implements StorePort {
  #companies = new Map<string, CompanyRecord>();
  #runs = new Map<string, RunRecord>();
  #steps = new Map<string, StepRecord>();
  #events: EventRecord[] = [];
  #approvals = new Map<string, ApprovalRecord>();
  #jobs: JobRunRecord[] = [];
  #n = 0;

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${this.#n}`;
  }

  async createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
    const record: CompanyRecord = {
      id: input.id ?? this.#id("cmp"),
      name: input.name,
      slug: input.slug,
      budgetCents: input.budgetCents ?? 0,
    };
    this.#companies.set(record.id, record);
    return record;
  }
  async getCompany(id: string): Promise<CompanyRecord | null> {
    return this.#companies.get(id) ?? null;
  }
  async deleteCompany(id: string): Promise<void> {
    this.#companies.delete(id);
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const record: RunRecord = {
      id: input.id,
      companyId: input.companyId,
      objective: input.objective,
      trigger: input.trigger,
      status: input.status,
      budgetCents: input.budgetCents ?? 0,
      costCents: 0,
      replanCount: 0,
      summary: null,
      startedAt: new Date(0),
      completedAt: null,
    };
    this.#runs.set(record.id, record);
    return record;
  }
  async getRun(id: string): Promise<RunRecord | null> {
    return this.#runs.get(id) ?? null;
  }
  async updateRun(id: string, patch: UpdateRunInput): Promise<RunRecord> {
    const current = this.#runs.get(id);
    if (!current) throw new Error(`no run ${id}`);
    const next = { ...current, ...patch } as RunRecord;
    this.#runs.set(id, next);
    return next;
  }

  async upsertStep(input: UpsertStepInput): Promise<StepRecord> {
    const record: StepRecord = {
      id: input.id,
      runId: input.runId,
      companyId: input.companyId,
      seq: input.seq,
      title: input.title,
      agentRole: input.agentRole,
      status: input.status,
      needsApproval: input.needsApproval ?? false,
      output: input.output ?? null,
      costCents: input.costCents ?? null,
      approvalId: input.approvalId ?? null,
    };
    this.#steps.set(record.id, record);
    return record;
  }
  async listSteps(runId: string): Promise<StepRecord[]> {
    return [...this.#steps.values()].filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq);
  }

  async appendEvent(input: Parameters<StorePort["appendEvent"]>[0]): Promise<EventRecord> {
    const record: EventRecord = {
      id: this.#id("evt"),
      runId: input.runId,
      companyId: input.companyId,
      seq: input.seq,
      kind: input.kind,
      stepId: input.stepId ?? null,
      payload: input.payload,
      createdAt: new Date(this.#n * 1000),
    };
    this.#events.push(record);
    return record;
  }
  async listEvents(runId: string, afterSeq = -1): Promise<EventRecord[]> {
    return this.#events.filter((e) => e.runId === runId && e.seq > afterSeq);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: input.id ?? this.#id("apr"),
      companyId: input.companyId,
      action: input.action,
      reason: input.reason,
      status: "pending",
      createdAt: new Date(this.#n * 1000),
      resolvedAt: null,
      expiresAt: input.expiresAt ?? null,
    };
    this.#approvals.set(record.id, record);
    return record;
  }
  async getApproval(id: string): Promise<ApprovalRecord | null> {
    return this.#approvals.get(id) ?? null;
  }
  async resolveApproval(id: string, status: "approved" | "rejected"): Promise<ApprovalRecord> {
    const current = this.#approvals.get(id);
    if (!current) throw new Error(`no approval ${id}`);
    const next: ApprovalRecord = { ...current, status, resolvedAt: new Date(this.#n * 1000) };
    this.#approvals.set(id, next);
    return next;
  }
  /** Not part of StorePort; the REPL's own pending-approval query lives in approvals.ts. */
  allApprovals(): ApprovalRecord[] {
    return [...this.#approvals.values()];
  }

  async createJobRun(input: CreateJobRunInput): Promise<JobRunRecord> {
    const record: JobRunRecord = {
      id: input.id ?? this.#id("job"),
      type: input.type,
      status: input.status ?? "running",
      companyId: input.companyId ?? null,
      trigger: input.trigger,
      summary: input.summary ?? "",
      resultCount: 0,
      error: null,
      startedAt: new Date(this.#n * 1000),
      completedAt: null,
    };
    this.#jobs.push(record);
    return record;
  }
  async listJobRuns(companyId: string | null, limit = 50): Promise<JobRunRecord[]> {
    return this.#jobs.filter((j) => companyId === null || j.companyId === companyId).slice(0, limit);
  }

  async close(): Promise<void> {}
}

// ── the harness ─────────────────────────────────────────────────────────────

export interface HarnessOptions {
  /** Events the fake run produces, in order. Defaults to a four-event run. */
  events?: OrcEvent[];
  config?: TrentConfig;
  degraded?: boolean;
  store?: MemoryStore;
}

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_h", at: "2026-09-12T00:00:00.000Z", ...extra } as OrcEvent;
}

export const DEFAULT_EVENTS: OrcEvent[] = [
  ev("run_start", { run: { objective: "plan the launch" } }),
  ev("step_start", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer" } }),
  ev("step_output", { step: { id: "s1" }, detail: "found 3 modules" }),
  ev("step_end", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer", costCents: 7 } }),
  ev("run_done", { run: { status: "completed" } }),
];

export interface Harness {
  engine: ReplEngine;
  store: MemoryStore;
  exit: Mock;
  out: string[];
  feed(chunk: string): void;
  transcript(): string[];
  emitted(n: number): Promise<void>;
  readonly streamCompleted: boolean;
  readonly promptsRendered: number;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const events = options.events ?? DEFAULT_EVENTS;
  const store = options.store ?? new MemoryStore();
  const exit = vi.fn();
  const out: string[] = [];
  let completed = false;
  let produced = 0;

  const engine = new ReplEngine({
    theme: createTheme("none"),
    config: options.config ?? DEFAULT_CONFIG,
    store,
    companyId: "cmp_test",
    degraded: options.degraded ?? false,
    write: (text: string) => void out.push(text),
    exit: (code: number) => void exit(code),
    runner: ({ signal }) =>
      (async function* () {
        for (const event of events) {
          if (signal.aborted) return;
          // A real stream yields to the event loop between frames; so must this one,
          // or an interrupt could never land mid-stream.
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (signal.aborted) return;
          produced += 1;
          yield event;
        }
        completed = true;
      })(),
  });

  return {
    engine,
    store,
    exit,
    out,
    feed: (chunk) => engine.feed(chunk),
    transcript: () => engine.transcript,
    emitted: async (n) => {
      for (let i = 0; i < 500 && produced < n; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    get streamCompleted() {
      return completed;
    },
    get promptsRendered() {
      return out.filter((line) => line.includes(PROMPT.trim())).length;
    },
  };
}
