/**
 * [S1] The solo prompt: one system prefix per session, byte-identical across turns (P2-7's rule, so
 * a provider cache can hit it), built from the persona, the stable tier and the tool disclosure in
 * that order. The date, the workspace and the turn's recall are the CONTEXT tier and ride the new
 * user message, after the history, never the prefix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, memorySession, scriptedGateway, sequentialIds } from "./fakes.test-helpers.js";
import { DEFAULT_SOLO_PERSONA, SOLO_TOOL_PROTOCOL } from "./prompt.js";
import { createSoloRunner } from "./runner.js";
import type { SoloMessage } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function profileWithPersona(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "brain", "system"), { recursive: true });
  fs.writeFileSync(path.join(dir, "brain", "system", "solo.md"), text);
  return dir;
}

function runnerWith(options: { profileDir?: string; history?: SoloMessage[]; replies?: string[] } = {}) {
  const gateway = scriptedGateway(options.replies ?? ["First answer.", "Second answer."]);
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: [files] },
    session: memorySession(options.history),
    memory: fakeMemory().memory,
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    workspace: "/work/oak-shop",
    ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
  });
  return { gateway, runner };
}

const systemOf = (messages: ReadonlyArray<{ role: string; content: string }> | undefined): string => messages?.find((m) => m.role === "system")?.content ?? "";

describe("[S1] the system prefix", () => {
  it("is byte-identical across two turns with different objectives, and across two sessions of the same profile", async () => {
    const a = runnerWith();
    await collect(a.runner.run({ objective: "How long does shipping take?" }));
    await collect(a.runner.run({ objective: "Which stain did we pick?" }));
    const b = runnerWith({ replies: ["Other answer."] });
    await collect(b.runner.run({ objective: "Something else entirely" }));

    const first = systemOf(a.gateway.requests[0]?.messages);
    expect(first).not.toBe("");
    expect(systemOf(a.gateway.requests[1]?.messages)).toBe(first);
    expect(systemOf(b.gateway.requests[0]?.messages)).toBe(first);
    expect(a.gateway.requests.every((r) => r.messages[0]?.role === "system" && r.messages.filter((m) => m.role === "system").length === 1)).toBe(true);
    // Nothing turn-dependent is in it.
    for (const text of ["shipping", "stain", "2026-09-26", "walnut", "/work/oak-shop"]) expect(first).not.toContain(text);
  });

  it("is persona, then the stable tier, then the tool protocol and the adapters' own instructions, in that order", async () => {
    const { gateway, runner } = runnerWith();
    await collect(runner.run({ objective: "Hello" }));
    const system = systemOf(gateway.requests[0]?.messages);
    const order = [DEFAULT_SOLO_PERSONA, "The company sells hand-made oak tables.", SOLO_TOOL_PROTOCOL, "### file_ops", 'read_file: the read_file tool.'].map((part) => system.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("takes the persona from <profile>/brain/system/solo.md when it is there", async () => {
    const profileDir = profileWithPersona("You are Oakley, the oak shop's own assistant.\n");
    const { gateway, runner } = runnerWith({ profileDir });
    await collect(runner.run({ objective: "Hello" }));
    const system = systemOf(gateway.requests[0]?.messages);
    expect(system.startsWith("You are Oakley, the oak shop's own assistant.")).toBe(true);
    expect(system).not.toContain(DEFAULT_SOLO_PERSONA);
  });

  it("keeps the default persona for a profile without the file", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-"));
    temps.push(empty);
    const { gateway, runner } = runnerWith({ profileDir: empty });
    await collect(runner.run({ objective: "Hello" }));
    expect(systemOf(gateway.requests[0]?.messages).startsWith(DEFAULT_SOLO_PERSONA)).toBe(true);
  });
});

describe("[S1] the messages after the prefix", () => {
  it("replays the session's history in order, then one user message: the context tier and the objective", async () => {
    const history: SoloMessage[] = [
      { role: "system", content: "Compacted transcript. 4 message(s) forgotten, 900 chars reclaimed.\nThe founder asked about oak." },
      { role: "user", content: "Do we stock oak?" },
      { role: "assistant", content: '<tool_call>\nread_file {"path": "stock.md"}\n</tool_call>' },
      { role: "tool", content: "ignored when a record is present", record: { adapter: "file_ops", action: 'read_file {"path": "stock.md"}', status: "completed", summary: "oak: 12 boards" } },
      { role: "assistant", content: "Yes, 12 boards." },
    ];
    const { gateway, runner } = runnerWith({ history });
    await collect(runner.run({ objective: "Order more." }));
    const messages = gateway.requests[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    // The compaction summary and the first user turn merge into one user message: roles alternate.
    expect(messages[1]?.content).toBe("Compacted transcript. 4 message(s) forgotten, 900 chars reclaimed.\nThe founder asked about oak.\n\nDo we stock oak?");
    expect(messages[3]?.content).toBe('<tool_result tool="read_file" status="completed">\noak: 12 boards\n</tool_result>');
    const last = messages.at(-1)?.content ?? "";
    expect(last.endsWith("\n\nOrder more.")).toBe(true);
    expect(last).toContain("Today is 2026-09-26 (UTC).");
    expect(last).toContain("Workspace: /work/oak-shop");
    expect(last).toContain("Last week the founder chose walnut stain.");
  });
});
