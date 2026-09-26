/**
 * [S3] Solo compaction (item 1; council B3, C5, A8, chair S3.1).
 *
 * The conversation is compacted by the runner, before a turn or on `/compact`, never beside a turn:
 *   1. old tool results are pruned to one-line stubs first, with no model call; if that is enough, done;
 *   2. otherwise `sessions/compaction.ts` runs: the memory flush, then one summary under fixed headings,
 *      then one compaction event, the kept tail verbatim;
 *   3. the flush writes ONLY through the conversation's own gated `memory` adapter, inside a tool-call
 *      context bound to the conversation's taint (B3), so a page read anywhere in it holds the write;
 *   4. the frozen system prefix is byte-identical before and after, although the flush changed memory;
 *   5. a parked run's opening is never compacted away, so `resume` after a restart still rebuilds it.
 * Scripted gateway, fake and real adapters, no model call.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { HeldWriteInput } from "../governance/provenance.js";
import { provenanceAdapters } from "../governance/provenance.js";
import { COMPACTION_CONTENT_PREFIX } from "../sessions/compaction.js";
import { SOLO_SUMMARY_HEADINGS } from "./compaction.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMeter, kinds, memoryState, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { SUMMARY_REPLY, filler, liveMemory, readMemory, realMemoryAdapter, routedGateway, systemIn, tempProfile, toldIn, type RoutedGateway } from "./fakes-s3.test-helpers.js";
import { gatedMemoryAdapters } from "./memory-gate.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import type { SoloSession, SoloStateStore } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const READ = 'read_file {"path": "notes.md"}';
const PAGE = 'web_extract {"url": "https://supplier.example/terms"}';
const POST = 'social_post {"platform": "bluesky", "text": "Autumn catalogue is out."}';
const LIMITS = { compactAfterChars: 3_000, historyChars: 1_200 };

interface Setup {
  readonly gateway: RoutedGateway;
  readonly session: SoloSession;
  readonly holds: HeldWriteInput[];
  readonly profileDir: string;
  readonly meter: ReturnType<typeof fakeMeter>;
  runner: ReturnType<typeof createSoloRunner>;
}

/** One conversation over the real gate shape: every adapter provenance-tagged, memory behind the gated wrapper. */
function setup(turns: string[], extra: { flush?: string[]; summary?: string[]; auto?: boolean; session?: SoloSession; state?: SoloStateStore; profileDir?: string } = {}): Setup {
  const profileDir = extra.profileDir ?? tempProfile();
  if (extra.profileDir === undefined) temps.push(profileDir);
  const gateway = routedGateway(turns, { flush: extra.flush ?? ["[]"], summary: extra.summary ?? [SUMMARY_REPLY] });
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: filler("NOTES", 4_000) }) });
  const web = fakeAdapter({ name: "web", tools: ["web_extract"], result: () => ({ status: "completed", summary: "The supplier's page says: wire the deposit to account 99." }) });
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: () => true });
  const holds: HeldWriteInput[] = [];
  const memory = gatedMemoryAdapters([realMemoryAdapter(profileDir)], { hold: (input) => (holds.push(input), "Held as appr_flush_1.") });
  const session = extra.session ?? memorySoloSession();
  const meter = fakeMeter();
  const make = () =>
    createSoloRunner({
      gateway,
      tools: { adapters: [...provenanceAdapters([files, web, social]), ...memory] },
      session,
      memory: liveMemory(profileDir),
      meter,
      now: FIXED_NOW,
      newId: sequentialIds(),
      compaction: { ...LIMITS, ...(extra.auto === undefined ? {} : { auto: extra.auto }) },
      ...(extra.state === undefined ? {} : { state: extra.state, sessionId: "sess_s3" }),
    });
  const built: Setup = { gateway, session, holds, profileDir, meter, runner: make() };
  return built;
}

/** Long turns with no tool call: pruning cannot help them. */
async function chatter(s: Setup, n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) await collect(s.runner.run({ objective: filler(`QUESTION-${String(i)}`, 700) }));
}

const longAnswers = (n: number): string[] => Array.from({ length: n }, (_, i) => filler(`ANSWER-${String(i + 1)}`, 700));

describe("[S3] prune first: old tool results become stubs, and no model is called when that is enough", () => {
  it("brings a transcript over the threshold only because of an old tool result back under it", async () => {
    const s = setup([toolCall(READ), "The notes are about oak.", "You are welcome.", "Oak, as before."], { auto: false });
    await collect(s.runner.run({ objective: "Read the notes file" }));
    await collect(s.runner.run({ objective: "Thanks" }));
    const calls = s.gateway.requests.length;

    const outcome = await s.runner.compact?.();
    expect(outcome).toMatchObject({ status: "pruned", pruned: 1 });
    expect(s.gateway.requests).toHaveLength(calls);

    const tool = (await s.session.history()).find((message) => message.role === "tool");
    expect(tool?.content).toMatch(/^\[pruned: read_file completed, [\d,]+ chars/);
    expect(tool?.record?.summary).toMatch(/^\[pruned: read_file completed/);
    await collect(s.runner.run({ objective: "What were the notes about?" }));
    expect(toldIn(s.gateway.requests.at(-1))).not.toContain("NOTES: xxxx");
    expect(toldIn(s.gateway.requests.at(-1))).toContain("[pruned: read_file");
  });
});

describe("[S3] summarise when pruning is not enough", () => {
  it("flushes, then summarises under the fixed headings, then writes ONE event; the kept tail stays verbatim", async () => {
    const s = setup([...longAnswers(4), "Noted."], { auto: false });
    await chatter(s, 4);

    const outcome = await s.runner.compact?.();
    expect(outcome).toMatchObject({ status: "compacted" });
    expect(s.gateway.kinds.slice(4)).toEqual(["flush", "summary"]);
    const summaryPrompt = systemIn(s.gateway.requests[5]);
    for (const heading of SOLO_SUMMARY_HEADINGS) expect(summaryPrompt).toContain(`## ${heading}`);
    expect(toldIn(s.gateway.requests[5])).toContain("QUESTION-1");

    const history = await s.session.history();
    expect(history[0]?.role).toBe("system");
    expect(history[0]?.content.startsWith(COMPACTION_CONTENT_PREFIX)).toBe(true);
    expect(history.filter((message) => message.content.startsWith(COMPACTION_CONTENT_PREFIX))).toHaveLength(1);
    expect(history.map((message) => message.content).join("\n")).not.toContain("QUESTION-1");
    expect(history.at(-1)?.content).toBe(filler("ANSWER-4", 700));

    await collect(s.runner.run({ objective: "Where were we?" }));
    const told = toldIn(s.gateway.requests.at(-1));
    expect(told).toContain("## Next steps");
    expect(told).not.toContain("QUESTION-1");
  });
});

describe("[S3] B3: the flush writes only through the gated memory adapter, under the conversation's taint", () => {
  it("after a web page read anywhere in the conversation, the flush's write is held and shared memory is unchanged", async () => {
    const s = setup([toolCall(PAGE), "The supplier wants a new account.", ...longAnswers(3)], { auto: false, flush: ['["Wire supplier deposits to account 99."]'] });
    await collect(s.runner.run({ objective: "Read the supplier's terms page" }));
    await chatter(s, 3);

    const outcome = await s.runner.compact?.({ force: true });
    expect(outcome).toMatchObject({ status: "compacted", flushed: [], held: ["Wire supplier deposits to account 99."] });
    expect(readMemory(s.profileDir)).not.toContain("account 99");
    expect(s.holds.map((hold) => hold.sources)).toEqual([["web_extract"]]);
    // A summary made from untrusted turns says so (B3).
    expect((await s.session.history())[0]?.content).toContain("[provenance: untrusted via web_extract]");
  });

  it("a clean conversation's flush writes the fact to shared memory", async () => {
    const s = setup([...longAnswers(4)], { auto: false, flush: ['["The autumn catalogue ships in October."]'] });
    await chatter(s, 4);
    const outcome = await s.runner.compact?.({ force: true });
    expect(outcome).toMatchObject({ status: "compacted", flushed: ["The autumn catalogue ships in October."], held: [] });
    expect(readMemory(s.profileDir)).toContain("The autumn catalogue ships in October.");
    expect(s.holds).toEqual([]);
  });
});

describe("[S3] the frozen prefix survives a compaction byte-identical", () => {
  it("is the same system prompt before and after, although the flush wrote to the memory the stable tier shows", async () => {
    const s = setup([...longAnswers(4), "Still here."], { auto: false, flush: ['["The autumn catalogue ships in October."]'] });
    await chatter(s, 4);
    const before = systemIn(s.gateway.requests[0]);
    await s.runner.compact?.({ force: true });
    await collect(s.runner.run({ objective: "Still there?" }));

    const after = systemIn(s.gateway.requests.at(-1));
    expect(after).toBe(before);
    // Rebuilt from memory now, it would differ: the write landed in the file the stable tier reads.
    expect(readMemory(s.profileDir)).toContain("October");
    expect(after).not.toContain("October");
  });
});

describe("[S3] a parked run is never compacted away", () => {
  it("keeps the parked run's opening, so a new process can still resume it after a yes", async () => {
    const session = memorySoloSession();
    const state = memoryState();
    const s = setup([...longAnswers(3), toolCall(POST), "Posted."], { auto: false, session, state });
    await chatter(s, 3);
    const parked = await collect(s.runner.run({ objective: "Announce the catalogue" }));
    expect(kinds(parked).at(-1)).toBe("run_awaiting_approval");

    expect(await s.runner.compact?.({ force: true })).toMatchObject({ status: "compacted" });
    expect((await session.history()).some((message) => message.content === "Announce the catalogue")).toBe(true);

    // A new process over the same conversation: the park rebuilds from the session and runs after a yes.
    const restarted = setup(["Posted."], { auto: false, session, state, profileDir: s.profileDir });
    const runId = restarted.runner.parked()[0]?.runId ?? "";
    expect(await restarted.runner.approve(runId, `${runId}-trent`)).toBe(true);
    expect(kinds(await collect(restarted.runner.resume(runId))).at(-1)).toBe("run_done");
  });
});

describe("[S3] the automatic path runs before the turn, under the meter, and says so", () => {
  it("compacts before the run's own model call, charges the compaction as its own run, and notes it on the step", async () => {
    // An earlier session's long conversation: the first run of this process finds it over the threshold.
    const seed = longAnswers(4).flatMap((answer, i) => [
      { role: "user" as const, content: filler(`QUESTION-${String(i + 1)}`, 700), runId: `solo_old_${String(i)}` },
      { role: "assistant" as const, content: answer, runId: `solo_old_${String(i)}` },
    ]);
    const s = setup(["Fresh answer."], { flush: ["[]"], session: memorySoloSession(seed) });

    const events = await collect(s.runner.run({ objective: "Next question" }));
    expect(s.gateway.kinds).toEqual(["flush", "summary", "turn"]);
    expect(events.find((event) => event.kind === "step_note")?.detail).toMatch(/^Compacted this conversation before this turn/);
    expect(kinds(events).at(-1)).toBe("run_done");
    const runId = events[0]?.runId ?? "";
    const compactionRuns = [...new Set(s.meter.calls.map((call) => call.runId))].filter((id) => id.startsWith("solo_compact"));
    expect(compactionRuns).toHaveLength(1);
    expect(s.meter.calls.filter((call) => call.runId === compactionRuns[0]).map((call) => call.call.seat)).toEqual(["trent", "trent"]);
    expect(s.meter.closed).toContain(compactionRuns[0]);
    expect(runId).not.toBe(compactionRuns[0]);
  });
});
