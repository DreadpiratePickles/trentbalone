/**
 * [P2-1] A pinned run in its own process: `trent run - --model <id> --format stream-json`.
 *
 * The spawn is a fake here, so what is asserted is the contract between the two processes: the
 * argv (the pin as a flag, the prompt NEVER in argv), the environment (the surface the child charges
 * its spend to), the prompt on stdin, the child's lines read back as the run bus's own `OrcEvent`s,
 * and every way the child can end without completing turned into a thrown reason.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { resolveServiceProgram, type ServiceProcessView } from "@trent/core/service/program.js";
import { setServiceHostForTests } from "../commands/groups/service.js";
import { runCli } from "../commands/index.js";
import { openChildRun, selfProgram, type ChildRunProcess, type ChildRunSpawn } from "./child-run.js";

const PIN = "gemini-3.6-flash";
const PROMPT = "--help summarise yesterday's pipeline";

interface Spawned {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  killed: Array<NodeJS.Signals | number | undefined>;
}

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

const EVENTS: OrcEvent[] = [
  { kind: "run_start", runId: "run_child", at: "2026-09-25T10:00:00.000Z", run: { objective: PROMPT, status: "planning" } },
  { kind: "step_end", runId: "run_child", at: "2026-09-25T10:00:01.000Z", step: { id: "stp_1", agentRole: "analyst", model: PIN, costCents: 2 } },
  { kind: "run_done", runId: "run_child", at: "2026-09-25T10:00:02.000Z", run: { status: "completed", summary: "brief" } },
];

/** A child that prints `stdout` then `stderr`, then closes with `code` — unless it is killed first. */
function fakeSpawn(spawned: Spawned[], script: { stdout: string[]; stderr?: string[]; code: number; hold?: boolean }): ChildRunSpawn {
  return (command, args, options) => {
    const record: Spawned = { command, args, env: options.env, stdin: "", killed: [] };
    spawned.push(record);
    const child = new EventEmitter() as EventEmitter & ChildRunProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      record.stdin += chunk.toString("utf8");
    });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill: (signal?: NodeJS.Signals | number) => {
        record.killed.push(signal);
        stdout.end();
        stderr.end();
        setImmediate(() => child.emit("close", null, "SIGINT"));
        return true;
      },
    });
    setImmediate(() => {
      for (const chunk of script.stdout) stdout.write(chunk);
      for (const chunk of script.stderr ?? []) stderr.write(chunk);
      if (script.hold === true) return;
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", script.code, null));
    });
    return child;
  };
}

async function collect(stream: AsyncIterable<OrcEvent>): Promise<{ events: OrcEvent[]; error?: Error }> {
  const events: OrcEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events };
  } catch (error) {
    return { events, error: error as Error };
  }
}

const SYSTEM = line({ type: "system", run_id: "run_child", profile: "work", provider: "google", model: PIN });
const eventLines = EVENTS.map((event) => line({ type: event.kind, ...event }));

describe("[P2-1] openChildRun", () => {
  it("runs `trent run - --model <id> --format stream-json` with the prompt on stdin, and yields the child's events verbatim", async () => {
    const spawned: Spawned[] = [];
    const logs: string[] = [];
    const child = openChildRun({
      profile: "work",
      model: PIN,
      surface: "cron",
      program: ["/usr/local/bin/node", "/opt/trent/dist/index.js"],
      spawn: fakeSpawn(spawned, {
        stdout: [SYSTEM, ...eventLines, line({ type: "result", status: "completed", cost_cents: 2, run_id: "run_child", model: PIN, models: [PIN] })],
        stderr: ["[Worker] Starting job plan\n"],
        code: 0,
      }),
      env: { TRENT_HOME: "/tmp/home", PATH: "/usr/bin" },
      log: (text) => logs.push(text),
    });

    const { events, error } = await collect(child.run(PROMPT, { trigger: "scheduled", model: PIN }));
    expect(error).toBeUndefined();
    expect(events).toEqual(EVENTS);

    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call!.command).toBe("/usr/local/bin/node");
    expect(call!.args).toEqual(["/opt/trent/dist/index.js", "--profile", "work", "run", "-", "--model", PIN, "--format", "stream-json", "--no-color"]);
    // The prompt rides stdin: argv is visible to every process on the host, and a prompt that
    // begins with `-` would be parsed as a flag.
    expect(call!.args.join(" ")).not.toContain("summarise");
    expect(call!.stdin).toBe(PROMPT);
    expect(call!.env).toMatchObject({ TRENT_HOME: "/tmp/home", PATH: "/usr/bin", TRENT_RUN_SURFACE: "cron" });
    expect(logs).toEqual(["[Worker] Starting job plan"]);
    await child.cleanup();
  });

  it("a result that did not complete throws its reason after the events it did carry", async () => {
    const spawned: Spawned[] = [];
    const failed = openChildRun({
      profile: "default",
      model: PIN,
      program: ["trent"],
      spawn: fakeSpawn(spawned, {
        stdout: [SYSTEM, eventLines[0]!, line({ type: "run_failed", kind: "run_failed", runId: "run_child", at: "x", detail: "provider returned 429" }), line({ type: "result", status: "failed", error: "provider returned 429" })],
        code: 1,
      }),
    });
    const outcome = await collect(failed.run(PROMPT, { trigger: "scheduled", model: PIN }));
    expect(outcome.events.map((event) => event.kind)).toEqual(["run_start", "run_failed"]);
    expect(outcome.error?.message).toBe("provider returned 429");

    const paused = openChildRun({
      profile: "default",
      model: PIN,
      program: ["trent"],
      spawn: fakeSpawn(spawned, { stdout: [SYSTEM, line({ type: "result", status: "paused", approval_id: "apr_1" })], code: 7 }),
    });
    const parked = await collect(paused.run(PROMPT, { trigger: "scheduled", model: PIN }));
    expect(parked.error?.message).toContain("apr_1");
  });

  it("a child that exits before any result throws its exit code and its own error line, and nothing else from stderr", async () => {
    const spawned: Spawned[] = [];
    const child = openChildRun({
      profile: "default",
      model: PIN,
      program: ["trent"],
      spawn: fakeSpawn(spawned, {
        stdout: [],
        stderr: ["executeSeatModel(ceo/google): failed the objective text\n", 'error: provider "acme" has no model gateway path\n', "  exit code: 3\n"],
        code: 3,
      }),
    });
    const { events, error } = await collect(child.run(PROMPT, { trigger: "scheduled", model: PIN }));
    expect(events).toEqual([]);
    expect(error?.message).toContain("exited 3");
    expect(error?.message).toContain('provider "acme" has no model gateway path');
    expect(error?.message).not.toContain("objective text");
  });

  it("a malformed pin never starts a process", () => {
    const spawned: Spawned[] = [];
    expect(() => openChildRun({ profile: "default", model: "gemini 9", program: ["trent"], spawn: fakeSpawn(spawned, { stdout: [], code: 0 }) })).toThrow(/model id/);
    expect(spawned).toEqual([]);
  });

  it("an abort interrupts the child with SIGINT, the way Ctrl+C stops `trent run`", async () => {
    const spawned: Spawned[] = [];
    const abort = new AbortController();
    const child = openChildRun({
      profile: "default",
      model: PIN,
      program: ["trent"],
      spawn: fakeSpawn(spawned, { stdout: [SYSTEM, eventLines[0]!], code: 0, hold: true }),
    });
    const running = collect(child.run(PROMPT, { trigger: "scheduled", model: PIN, signal: abort.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    const { error } = await running;
    expect(spawned[0]!.killed).toEqual(["SIGINT"]);
    expect(error?.message).toMatch(/interrupted|SIGINT/);
  });

  it("refuses a run that names another model than the one the child is built for", async () => {
    const child = openChildRun({ profile: "default", model: PIN, program: ["trent"], spawn: fakeSpawn([], { stdout: [], code: 0 }) });
    const { error } = await collect(child.run(PROMPT, { trigger: "scheduled", model: "gemini-3.5-flash-lite" }));
    expect(error?.message).toContain(PIN);
  });
});

describe("[P2-1] selfProgram: the trent this process is", () => {
  // [P2-10] The process state is stated outright, its symlinks included: none here.
  const noLinks = (p: string): string => p;

  it("the compiled binary is its own executable", () => {
    expect(selfProgram({ execPath: "/usr/local/bin/trent", argv: ["/usr/local/bin/trent", "/$bunfs/root/trent"], execArgv: [], bunVersion: "1.3.0" }, noLinks)).toEqual(["/usr/local/bin/trent"]);
  });

  it("the bundled CLI under Node is node and its entry; a source checkout keeps tsx's loader flags but never an inspector", () => {
    expect(selfProgram({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/opt/trent/dist/index.js"], execArgv: ["--inspect=9229"] }, noLinks)).toEqual(["/usr/bin/node", "/opt/trent/dist/index.js"]);
    expect(
      selfProgram({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/repo/apps/cli/src/index.ts"], execArgv: ["--require", "/repo/node_modules/tsx/dist/preflight.cjs", "--import", "file:///repo/node_modules/tsx/dist/loader.mjs", "--inspect-brk"] }, noLinks),
    ).toEqual(["/usr/bin/node", "--require", "/repo/node_modules/tsx/dist/preflight.cjs", "--import", "file:///repo/node_modules/tsx/dist/loader.mjs", "/repo/apps/cli/src/index.ts"]);
  });

  it("[P2-10] a process with no entry script is refused as the pinned run's own refusal, not the service install's", () => {
    let caught: unknown;
    try {
      selfProgram({ execPath: "/usr/bin/node", argv: ["/usr/bin/node"], execArgv: [] }, noLinks);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrentError);
    expect(caught).toMatchObject({ code: EXIT.CONFIG, operation: "run.child" });
    expect((caught as Error).message).toContain("pinned run");
    expect((caught as Error).message).not.toContain("install");
  });
});

/** Symlinks resolved as `fs.realpathSync` would: a fixed table, so no file is needed. */
const links: Record<string, string> = {
  "/usr/local/bin/trent": "/usr/local/lib/node_modules/trent-cli/dist/index.js",
  "/opt/homebrew/bin/trent-bin": "/opt/homebrew/Cellar/trent/1.0.0/bin/trent",
};
const realpath = (p: string): string => links[p] ?? p;
const TSX = ["--require", "/repo/node_modules/tsx/dist/preflight.cjs", "--import", "file:///repo/node_modules/tsx/dist/loader.mjs"];

// [P2-10] One resolver (`@trent/core/service/program.ts`): the unit `trent service install` writes and
// a pinned job's child start the same trent, whatever this process is.
describe("[P2-10] a pinned run's child and the service unit start the same trent", () => {
  const states: Record<string, ServiceProcessView> = {
    "the compiled binary through a symlink": { execPath: "/opt/homebrew/bin/trent-bin", argv: ["bun", "/$bunfs/root/trent"], execArgv: [], bunVersion: "1.3.0" },
    "the npm-installed CLI through its bin symlink": { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/usr/local/bin/trent"], execArgv: ["--max-old-space-size=4096"] },
    "a source checkout under tsx with an inspector": { execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/repo/apps/cli/src/index.ts"], execArgv: [...TSX, "--inspect=9229"] },
    "Bun running the source": { execPath: "/Users/f/.bun/bin/bun", argv: ["/Users/f/.bun/bin/bun", "/repo/apps/cli/src/index.ts"], execArgv: [], bunVersion: "1.3.0" },
  };
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-child-program-"));
    process.env.TRENT_HOME = path.join(scratch, ".trent");
  });

  afterEach(() => {
    setServiceHostForTests(undefined);
    delete process.env.TRENT_HOME;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  for (const [state, view] of Object.entries(states)) {
    it(`${state}: the same argv from both call sites`, async () => {
      setServiceHostForTests({ platform: "darwin", homeDir: scratch, uid: 501, exec: () => ({ code: 0, stdout: "", stderr: "" }), processView: view, realpath, cwd: scratch, pathEnv: "/usr/bin:/bin" });
      const install = await runCli(["service", "install", "--dry-run", "--json"]);
      expect(install.exitCode, install.stdout).toBe(EXIT.OK);
      const unit = (JSON.parse(install.stdout) as { programArguments: string[] }).programArguments;
      const daemon = ["service", "daemon", "--profile", "default", "--no-color"];
      expect(unit.slice(-daemon.length)).toEqual(daemon);
      expect(selfProgram(view, realpath)).toEqual(unit.slice(0, -daemon.length));
      expect(selfProgram(view, realpath)).toEqual(resolveServiceProgram(view, realpath).argv);
    });
  }
});
