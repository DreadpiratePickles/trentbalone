/**
 * [D1] `trent improve goldens` — the human gate between a captured failure and a seat's exam.
 *
 *   list              every golden under `<profile>/goldens`, its review state and the seats it gates,
 *                     and [W3] every retrieval golden under `goldens/retrieval` with its source
 *   show <id>         the golden, and the fixture it becomes (prompt and graders)
 *   add --retrieval   [W3] a founder's retrieval golden: `--query "..." --expect <chunk-id>`
 *   promote <id>      quarantined -> promoted; from here it is part of the seat's suite (or, for a
 *                     retrieval golden, of the recall gate's set)
 *   reject <id>       quarantined -> rejected; it never enters a suite again
 *
 * Plan decision 4: suites grow from failures captured on real runs, never from an agent or a
 * founder writing an exam. Promotion is the ONLY way a fixture enters a gate, it is a human
 * command, and the loop itself cannot write this directory — `<profile>/goldens` is frozen
 * (`improve/frozen-surface.ts`, class `golden`).
 *
 * This module also carries the plumbing the sweep needs from the same files: which seats a golden
 * belongs to (the runs' traces), the suites that follow from that, and the reflection floor
 * `--live` is held to.
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { BUNDLED_SKILLS_DIR } from "@trent/core/fleet/index.js";
import {
  BUNDLED_MECHANICAL_OVERLAYS_DIR,
  addRetrievalGolden,
  createSeatSuites,
  defaultSeatPromptProvider,
  getGolden,
  goldenFixture,
  goldenSeats,
  goldensByAgent,
  goldensDir,
  listGoldens,
  listRetrievalGoldens,
  nowIso,
  promotedGoldens,
  quarantinedGoldens,
  retrievalGoldensDir,
  reviewOf,
  setGoldenStatus,
  setRetrievalGoldenStatus,
  verifyPromotion,
  type ActualsRunner,
  type GoldenReview,
  type JudgeFn,
  type RetrievalGolden,
  type SeatSuites,
  type StoredGolden,
  type VerifyPromotionReport,
} from "@trent/core/improve/index.js";
import type { AgentTraceRow, ImproveStorePort } from "@trent/core/store/index.js";
import type { CommandContext } from "./context.js";
import type { CommandSpec } from "./registry.js";

/** The gate numbers a post-promotion holdout re-run is metered and scored with ([D0] gate 4). */
export interface HoldoutGates {
  readonly passK: number;
  readonly holdoutRatio: number;
  readonly sweepCapCents: number;
}

export function goldenDirFor(ctx: CommandContext): string {
  return goldensDir(ctx.config().getProfileDir());
}

/** [W3] Where the profile's retrieval goldens live: inside the goldens tree, so the same freeze covers them. */
export function retrievalGoldenDirFor(ctx: CommandContext): string {
  return retrievalGoldensDir(ctx.config().getProfileDir());
}

/** Which agents ran a step in each run: the seat attribution a capture does not carry itself. */
export function rolesByRun(traces: readonly AgentTraceRow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of traces) {
    const seats = index.get(row.runId) ?? [];
    for (const id of [row.agentRole, row.agentId]) if (id && !seats.includes(id)) seats.push(id);
    index.set(row.runId, seats);
  }
  return index;
}

/** Every golden, plus the agents each one may gate. Built once per command, from the profile. */
export interface GoldenIndex {
  readonly dir: string;
  readonly goldens: readonly StoredGolden[];
  readonly runs: ReadonlyMap<string, readonly string[]>;
  readonly byAgent: ReadonlyMap<string, readonly StoredGolden[]>;
}

export async function loadGoldenIndex(dir: string, traces: readonly AgentTraceRow[]): Promise<GoldenIndex> {
  const goldens = await listGoldens(dir);
  const runs = rolesByRun(traces);
  return { dir, goldens, runs, byAgent: goldensByAgent(goldens, runs) };
}

/** The suites the CLI gates against: a seat's promoted goldens and its skills, a specialist's skills. */
export function seatSuitesFor(index: GoldenIndex): SeatSuites {
  return createSeatSuites({
    skillsRoot: BUNDLED_SKILLS_DIR,
    overlayRoot: BUNDLED_MECHANICAL_OVERLAYS_DIR,
    goldensFor: (agentId) => index.byAgent.get(agentId) ?? [],
  });
}

export interface ReflectionFloor {
  readonly minGoldens: number;
  readonly eligible: string[];
  /** Why reflection may not run, naming every agent in scope and its count. Null when it may. */
  readonly blocked: string | null;
}

/**
 * [D1] reflection costs model calls, so it is held to a floor: an agent in scope must have at
 * least `improve.min_goldens` PROMOTED goldens. A reflection measured on one or two fixtures is
 * noise with a bill attached, and the holdout it would be judged on would be empty.
 */
export function reflectionFloor(index: GoldenIndex, agents: readonly string[], minGoldens: number): ReflectionFloor {
  const counted = agents.map((agentId) => {
    const goldens = index.byAgent.get(agentId) ?? [];
    return { agentId, promoted: promotedGoldens([...goldens]).length, quarantined: quarantinedGoldens([...goldens]).length };
  });
  const eligible = counted.filter((row) => row.promoted >= minGoldens).map((row) => row.agentId);
  if (eligible.length > 0) return { minGoldens, eligible, blocked: null };
  const counts = counted.map((row) => `${row.agentId}=${row.promoted}/${row.quarantined}`).join(" ");
  return {
    minGoldens,
    eligible,
    blocked: `--live needs an agent with at least improve.min_goldens (${minGoldens}) promoted goldens; promoted/quarantined per agent: ${counts || "none"}`,
  };
}

interface GoldenRow {
  id: string;
  runId: string;
  review: GoldenReview;
  seats: string[];
  failureTags: string[];
  objective: string;
  reason: string;
  capturedAt?: string;
  promotedAt?: string;
  rejectedAt?: string;
}

function toRow(golden: StoredGolden, runs: ReadonlyMap<string, readonly string[]>): GoldenRow {
  return {
    id: golden.id,
    runId: golden.runId,
    review: reviewOf(golden),
    seats: [...goldenSeats(golden, runs)],
    failureTags: [...(golden.trajectoryFailureTags ?? [])],
    objective: golden.objective,
    reason: golden.reason,
    ...(golden.capturedAt === undefined ? {} : { capturedAt: golden.capturedAt }),
    ...(golden.promotedAt === undefined ? {} : { promotedAt: golden.promotedAt }),
    ...(golden.rejectedAt === undefined ? {} : { rejectedAt: golden.rejectedAt }),
  };
}

/** [W3] One retrieval golden as `list` shows it: the query, what must rank, where it came from. */
interface RetrievalRow {
  id: string;
  review: GoldenReview;
  source: RetrievalGolden["source"];
  query: string;
  expected: string[];
  runId: string | null;
}

function toRetrievalRow(golden: RetrievalGolden): RetrievalRow {
  return { id: golden.id, review: reviewOf(golden), source: golden.source, query: golden.query, expected: [...golden.expected_chunk_ids], runId: golden.runId ?? null };
}

/**
 * The dry-run answer every id-taking goldens command gives: what it would act on and whether that
 * id is there, at exit 0 and without touching the file. The registry probes every command this way
 * (`__tests__/registry.test.ts`), and the real refusal still stands outside a dry run.
 */
async function dryRunAnswer(ctx: CommandContext, command: string, goldenId: string): Promise<{ data: Record<string, unknown> }> {
  const dir = goldenDirFor(ctx);
  const golden = (await listGoldens(dir)).find((candidate) => candidate.id === goldenId);
  const retrieval = golden === undefined ? (await listRetrievalGoldens(retrievalGoldenDirFor(ctx))).find((candidate) => candidate.id === goldenId) : undefined;
  const found = golden ?? retrieval;
  return { data: { dryRun: true, command, dir, goldenId, exists: found !== undefined, kind: golden ? "failure" : retrieval ? "retrieval" : null, review: found ? reviewOf(found) : null } };
}

export interface GoldensDeps {
  /** The trace store's runs, so a golden can be attributed to the seats that produced it. */
  readonly runsFor: (ctx: CommandContext) => Promise<Map<string, string[]>>;
}

function listSpec(deps: GoldensDeps): CommandSpec {
  return {
    name: "list",
    description: "Captured failure goldens, their review state and the seats they gate",
    run: async (ctx) => {
      const dir = goldenDirFor(ctx);
      const runs = await deps.runsFor(ctx);
      const goldens = (await listGoldens(dir)).map((golden) => toRow(golden, runs));
      const retrieval = (await listRetrievalGoldens(retrievalGoldenDirFor(ctx))).map(toRetrievalRow);
      return { data: { dir, goldens, retrieval } };
    },
    render(data, ctx) {
      const d = data as unknown as { dir: string; goldens: GoldenRow[]; retrieval: RetrievalRow[] };
      const review = (r: GoldenReview) => (r === "promoted" ? ctx.theme.success(r) : ctx.theme.meta(r));
      const lines = d.goldens.map((g) => `  ${ctx.theme.value(g.id)} ${review(g.review)} seats=${g.seats.join(",") || "none"} tags=${g.failureTags.join(",") || "none"} ${g.objective.slice(0, 60)}`);
      if (lines.length === 0) lines.push(`  ${ctx.theme.meta("goldens")} none captured under ${d.dir}`);
      for (const r of d.retrieval) lines.push(`  ${ctx.theme.value(r.id)} ${review(r.review)} ${ctx.theme.meta("retrieval")} ${r.source} expects=${r.expected.join(",")} ${r.query.slice(0, 60)}`);
      return lines;
    },
  };
}

function showSpec(deps: GoldensDeps): CommandSpec {
  return {
    name: "show <goldenId>",
    description: "One golden and the eval fixture it becomes",
    run: async (ctx, _opts, args) => {
      const dir = goldenDirFor(ctx);
      const goldenId = args[0] ?? "";
      if (ctx.dryRun) return dryRunAnswer(ctx, "improve goldens show", goldenId);
      const golden = await getGolden(dir, goldenId);
      const runs = await deps.runsFor(ctx);
      return { data: { dir, golden: toRow(golden, runs), fixture: goldenFixture(golden) } };
    },
    render(data, ctx) {
      const d = data as unknown as { dryRun?: boolean; goldenId?: string; exists?: boolean; golden: GoldenRow; fixture: { id: string; prompt: string; graders: Array<{ type: string; rubric?: string }> } };
      if (d.dryRun === true) return [`  ${ctx.theme.meta("would show")} ${ctx.theme.value(String(d.goldenId ?? ""))} (${d.exists === true ? "captured" : "no such golden"})`];
      return [
        `  ${ctx.theme.value(d.golden.id)} ${ctx.theme.meta(d.golden.review)}  run ${d.golden.runId}  seats ${d.golden.seats.join(",") || "none"}`,
        `  ${ctx.theme.meta("captured for")} ${d.golden.reason}`,
        `  ${ctx.theme.meta("fixture")} ${d.fixture.id}`,
        `  ${ctx.theme.meta("prompt")} ${d.fixture.prompt}`,
        ...d.fixture.graders.map((g) => `    ${ctx.theme.meta(g.type.padEnd(12))} ${g.rubric ?? ""}`),
      ];
    },
  };
}

function reviewCommand(review: Extract<GoldenReview, "promoted" | "rejected">): CommandSpec {
  return {
    name: `${review === "promoted" ? "promote" : "reject"} <goldenId>`,
    description:
      review === "promoted"
        ? "Promote a captured golden into its seats' eval suite (human command)"
        : "Reject a captured golden so it never enters a suite",
    run: async (ctx, _opts, args) => {
      const dir = goldenDirFor(ctx);
      const goldenId = args[0] ?? "";
      if (ctx.dryRun) return dryRunAnswer(ctx, `improve goldens ${review}`, goldenId);
      // [W3] A retrieval golden is reviewed through the same two commands; the id says which store.
      if ((await listRetrievalGoldens(retrievalGoldenDirFor(ctx))).some((candidate) => candidate.id === goldenId)) {
        const updated = await setRetrievalGoldenStatus(retrievalGoldenDirFor(ctx), goldenId, review, nowIso());
        return { data: { goldenId: updated.id, kind: "retrieval", runId: updated.runId ?? null, review: reviewOf(updated), at: updated.promotedAt ?? updated.rejectedAt ?? null } };
      }
      const updated = await setGoldenStatus(dir, goldenId, review, nowIso());
      return { data: { goldenId: updated.id, kind: "failure", runId: updated.runId, review: reviewOf(updated), at: updated.promotedAt ?? updated.rejectedAt ?? null } };
    },
    render(data, ctx) {
      const d = data as { goldenId?: string; review?: string; dryRun?: boolean; exists?: boolean };
      if (d.dryRun === true) {
        return [`  ${ctx.theme.meta("would set")} ${ctx.theme.value(String(d.goldenId ?? ""))} from ${String(d.review ?? "no such golden")} to ${review}`];
      }
      return [`  ${ctx.theme.success(review)} ${ctx.theme.value(String(d.goldenId ?? ""))}`];
    },
  };
}

/**
 * [W3] `trent improve goldens add --retrieval --query "..." --expect <chunk-id>[,<chunk-id>]`: the
 * founder names a chunk they know answers a question. It starts quarantined like a capture, so the
 * promotion is still a separate, deliberate command. Without `--retrieval` there is nothing to add:
 * failure goldens come from runs only (plan decision 4).
 */
const addSpec: CommandSpec = {
  name: "add",
  description: "Add a founder's retrieval golden: a query and the chunk id(s) the ranker must put in its top 8",
  options: [
    { flags: "--retrieval", description: "The golden is a retrieval golden (the only kind a founder may add)" },
    { flags: "--query <text>", description: "The question, as a seat would be asked it" },
    { flags: "--expect <chunkIds>", description: "Chunk id(s) that answer it, comma-separated (lease#7, decisions/2026-09-10-churn.md#1)" },
    { flags: "--seat <seat>", description: "Rank for this seat's view (its own notes included); the shared view when omitted" },
  ],
  run: async (ctx, opts) => {
    const query = typeof opts.query === "string" ? opts.query.trim() : "";
    const expected = (typeof opts.expect === "string" ? opts.expect : "").split(",").map((id) => id.trim()).filter((id) => id !== "");
    const seat = typeof opts.seat === "string" && opts.seat.trim() !== "" ? opts.seat.trim() : undefined;
    const dir = retrievalGoldenDirFor(ctx);
    if (ctx.dryRun) return { data: { dryRun: true, command: "improve goldens add", dir, retrieval: opts.retrieval === true, query, expected, seat: seat ?? null } };
    if (opts.retrieval !== true) throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens.add", message: "only a retrieval golden can be added by hand (--retrieval); failure goldens are captured from runs" });
    if (query === "") throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens.add", message: "--query is required: the question the ranker must answer" });
    if (expected.length === 0) throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens.add", message: "--expect is required: at least one chunk id that answers the query" });
    const golden = await addRetrievalGolden(dir, { query, expected_chunk_ids: expected, source: "founder", ...(seat === undefined ? {} : { seat }) }, nowIso());
    return { data: { dir, golden: toRetrievalRow(golden) } };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; query?: string; expected?: string[]; golden?: RetrievalRow };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would add")} retrieval golden ${ctx.theme.value(d.query ?? "")} expecting ${(d.expected ?? []).join(",") || "nothing"}`];
    return [`  ${ctx.theme.success("added")} ${ctx.theme.value(d.golden?.id ?? "")} ${ctx.theme.meta(d.golden?.review ?? "")} expects=${(d.golden?.expected ?? []).join(",")}`];
  },
};

export function goldensSpec(deps: GoldensDeps): CommandSpec {
  return {
    name: "goldens",
    description: "The captured failure goldens a seat's eval suite is built from, the retrieval goldens, and their review",
    subcommands: [listSpec(deps), showSpec(deps), addSpec, reviewCommand("promoted"), reviewCommand("rejected")],
  };
}

/** The refusal `--live` raises below the floor. Kept here so the message and the check are one file. */
export function reflectionRefusal(floor: ReflectionFloor): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "improve.sweep", message: floor.blocked ?? "reflection is not available" });
}

/**
 * [D0] gate 4: re-run the promoted artifact's holdout under the sweep cap. Returns null when the
 * agent has no suite to re-run. [D1] moved here, because the suite it re-runs is the seat's.
 */
export async function holdoutRecheck(
  gates: HoldoutGates,
  store: ImproveStorePort,
  companyId: string,
  draftId: string,
  actuals: ActualsRunner,
  judge: JudgeFn,
  suites: SeatSuites,
): Promise<VerifyPromotionReport | null> {
  const draft = await store.getDraft(draftId);
  if (!draft) return null;
  const suite = await suites.suiteFor(draft.agentId);
  if (!suite) return null;
  // The seat a specialist is plugged into comes from its own traces, as the sweep resolves it.
  const traces = await store.listTraces(companyId, { agentId: draft.agentId });
  const seatPrompt = await defaultSeatPromptProvider(store, companyId, () => traces[0]?.agentRole)(draft.agentId);
  return verifyPromotion({
    store,
    draftId,
    suite,
    seatPrompt,
    actuals,
    judge,
    passK: gates.passK,
    holdoutRatio: gates.holdoutRatio,
    budgetCents: gates.sweepCapCents,
  });
}
