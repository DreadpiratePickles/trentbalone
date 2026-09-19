/**
 * Session compaction: what happens when the stored transcript outgrows what a run may be told.
 *
 * The audit found no compaction of any kind (A.1): a long session either fell off the bounded
 * history silently or, once the REPL threaded it, grew until the provider errored. Compaction is
 * the honest version of the same thing — the turns that are about to leave the prompt are first
 * OFFERED to the memory write path (the same one the `memory` tool uses), then summarised into one
 * message, and exactly one compaction event records which message ids were forgotten.
 *
 * No model is called here. The summariser and the flush's distiller are injected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryAdapter } from "../tools/memory/index.js";
import {
  COMPACTION_SUMMARY_ROLE,
  compactSession,
  createMemoryFlush,
  isCompactionEvent,
  planCompaction,
  shouldCompact,
  transcriptChars,
  type CompactionLimits,
} from "./compaction.js";
import type { SessionMessage } from "./schema.js";

const LIMITS: CompactionLimits = { historyChars: 400 };

let profileDir = "";
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-compaction-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function message(id: string, role: SessionMessage["role"], content: string, metadata?: SessionMessage["metadata"]): SessionMessage {
  return { id, role, content, timestamp: "2026-09-18T10:00:00.000Z", ...(metadata === undefined ? {} : { metadata }) };
}

/** Twelve turns of 100 chars each: well past `historyChars * 2`. */
function longTranscript(): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 0; i < 6; i += 1) {
    out.push(message(`u${i}`, "user", `question ${i} `.padEnd(100, "x")));
    out.push(message(`a${i}`, "assistant", `answer ${i} `.padEnd(100, "y")));
  }
  return out;
}

const summarise = async (dropped: readonly SessionMessage[]): Promise<string> =>
  `Earlier in this session: ${dropped.length} messages, from ${dropped[0]?.id} to ${dropped.at(-1)?.id}.`;

describe("session compaction", () => {
  it("does not fire until the transcript passes history_chars times two", async () => {
    const small = [message("u0", "user", "x".repeat(300)), message("a0", "assistant", "y".repeat(300))];
    expect(transcriptChars(small)).toBe(600);
    expect(shouldCompact(small, LIMITS)).toBe(false);
    expect(shouldCompact([...small, message("u1", "user", "z".repeat(300))], LIMITS)).toBe(true);
    expect((await compactSession({ messages: small, limits: LIMITS, summarise })).status).toBe("not_needed");
  });

  it("honours an explicit compact_after_chars over the doubled history budget", () => {
    const messages = [message("u0", "user", "x".repeat(500))];
    expect(shouldCompact(messages, LIMITS)).toBe(false);
    expect(shouldCompact(messages, { ...LIMITS, compactAfterChars: 400 })).toBe(true);
  });

  it("records ONE compaction event carrying the forgotten ids and the summary", async () => {
    const messages = longTranscript();
    const result = await compactSession({ messages, limits: LIMITS, summarise, now: "2026-09-18T11:00:00.000Z" });
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") return;

    const events = result.messages.filter(isCompactionEvent);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.role).toBe(COMPACTION_SUMMARY_ROLE);
    expect(event.metadata?.compaction?.forgotten).toEqual(result.forgotten);
    expect(result.forgotten.length).toBeGreaterThan(0);
    expect(event.metadata?.compaction?.summary).toBe(result.summary);
    expect(event.content).toContain(result.summary);
    // Every forgotten id is gone from the transcript, and every kept id survives verbatim.
    for (const id of result.forgotten) expect(result.messages.some((m) => m.id === id)).toBe(false);
    expect(result.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  it("leaves the next run's history under the ceiling", async () => {
    const result = await compactSession({ messages: longTranscript(), limits: LIMITS, summarise });
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") return;
    expect(transcriptChars(result.messages)).toBeLessThanOrEqual(LIMITS.historyChars * 2);
  });

  it("never splits a tool call from its result", () => {
    const messages: SessionMessage[] = [
      message("u0", "user", "a".repeat(400)),
      message("a0", "assistant", "b".repeat(200), { tool_calls: [{ name: "file_ops", args: { path: "x" }, result: null }] }),
      message("t0", "tool", "c".repeat(200)),
      message("u1", "user", "d".repeat(50)),
      message("a1", "assistant", "e".repeat(50)),
    ];
    const plan = planCompaction(messages, { historyChars: 250 });
    const keptIds = plan.keep.map((m) => m.id);
    const droppedIds = plan.drop.map((m) => m.id);
    // a0 called the tool and t0 is its result: they are on the same side of the boundary.
    expect(keptIds.includes("a0")).toBe(keptIds.includes("t0"));
    expect(droppedIds.includes("a0")).toBe(droppedIds.includes("t0"));
    expect([...droppedIds, ...keptIds].sort()).toEqual(messages.map((m) => m.id).sort());
  });

  it("keeps the most recent turns verbatim", () => {
    const messages = longTranscript();
    const plan = planCompaction(messages, LIMITS);
    expect(plan.keep.at(-1)).toEqual(messages.at(-1));
    expect(plan.keep.length).toBeGreaterThan(0);
    expect(plan.drop[0]).toEqual(messages[0]);
  });

  it("offers the dropped turns to the memory write path before it summarises", async () => {
    const memory = createMemoryAdapter({ profileDir });
    const prompts: string[] = [];
    const gateway = {
      complete: async (request: { messages: Array<{ role: string; content: string }> }) => {
        prompts.push(request.messages.map((m) => m.content).join("\n"));
        return { text: JSON.stringify(["The founder prefers integer cents in every report."]), costCents: 0 };
      },
    };
    const flush = createMemoryFlush({ memory, gateway, companyId: "co_flush" });
    const order: string[] = [];
    const result = await compactSession({
      messages: longTranscript(),
      limits: LIMITS,
      flush: async (dropped) => {
        order.push("flush");
        await flush(dropped);
      },
      summarise: async (dropped) => {
        order.push("summarise");
        return summarise(dropped);
      },
    });

    expect(result.status).toBe("compacted");
    expect(order).toEqual(["flush", "summarise"]);
    expect(prompts).toHaveLength(1);
    // The turns about to be forgotten are what the memory path was offered.
    expect(prompts[0]).toContain("question 0");
    expect(prompts[0]).toContain("answer 0");
    expect(fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8")).toContain("integer cents");
  });

  it("writes nothing to memory when the model call is unavailable", async () => {
    const memory = createMemoryAdapter({ profileDir });
    const noGateway = createMemoryFlush({ memory, companyId: "co_flush" });
    expect((await noGateway(longTranscript())).status).toBe("unavailable");

    const failing = createMemoryFlush({
      memory,
      companyId: "co_flush",
      gateway: { complete: async () => { throw new Error("no provider configured"); } },
    });
    const report = await failing(longTranscript());
    expect(report.status).toBe("unavailable");
    expect(report.entries).toEqual([]);
    expect(fs.existsSync(path.join(profileDir, "memories", "MEMORY.md"))).toBe(false);
  });

  it("refuses a read-only block through the same adapter the memory tool uses", async () => {
    const memory = createMemoryAdapter({ profileDir });
    const flush = createMemoryFlush({
      memory,
      companyId: "co_flush",
      block: "company",
      gateway: { complete: async () => ({ text: JSON.stringify(["a fact"]), costCents: 0 }) },
    });
    const report = await flush(longTranscript());
    expect(report.status).toBe("refused");
    expect(report.refused.join(" ")).toContain("company");
    expect(fs.existsSync(path.join(profileDir, "memories", "COMPANY.md"))).toBe(false);
  });

  it("compacts nothing when the summariser is unavailable", async () => {
    const result = await compactSession({
      messages: longTranscript(),
      limits: LIMITS,
      summarise: async () => { throw new Error("no provider configured"); },
    });
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toContain("no provider configured");
  });
});
