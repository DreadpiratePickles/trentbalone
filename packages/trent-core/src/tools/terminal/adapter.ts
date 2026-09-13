/**
 * `terminal`: Hermes's `terminal(command; timeout<=600, workdir, background)` and
 * `process_manage(action; session_id, ...)` over the seat's sandbox.
 *
 * Approval order is exactly Hermes's `check_all_command_guards` (`approval.py:1025-1083`):
 *   1. the hardline floor — checked again INSIDE execute, because approval is loop-wide;
 *   2. every dangerous finding merged into ONE needs_approval summary, so an approval replay
 *      cannot approve one finding while another was hidden;
 *   3. the always-approve list: sudo, rm -r, git push, curl|sh.
 * Commands that need the network run in the bridge container behind the egress proxy; without
 * an egress configuration they run with no network at all, never with raw host networking.
 */
import { intArg, parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { dangerous, floorBlock } from "../approval-floors.js";
import { createSandbox, shellQuote, type Sandbox } from "../sandbox.js";
import { fitSummary, headTail } from "../spillover.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { ProcessRegistry, type BackgroundProcess } from "./processes.js";

export const TERMINAL_NAME = "terminal";
export const TERMINAL_SCOPES = ["terminal", "process_manage"];

const SPECS: readonly ToolSpec[] = [
  { name: "terminal", primary: "command", signature: ["command"] },
  { name: "process_manage", primary: "action", signature: ["action"] },
];

const DEFAULT_TIMEOUT_S = 180;
const MAX_TIMEOUT_S = 600;
const PWD_MARKER = "__TRENT_PWD__:";
const PWD_MARKER_END = "__END__";
const ALWAYS_APPROVE: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|[\s;&|(`])sudo\b/, "sudo"],
  [/\brm\s+(?:-[^\s]*r|--recursive)/i, "rm -r"],
  [/\bgit\s+push\b/, "git push"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:[/\w]*\/)?(?:ba|z|da)?sh\b/, "curl | sh"],
];
/** Commands whose purpose is the network: they run behind the egress proxy or not at all. */
const NEEDS_EGRESS =
  /\b(?:curl|wget|pip3?|npm|npx|pnpm|yarn|apt(?:-get)?|apk|brew|cargo|gem|composer|ssh|scp|rsync|nc|ping|dig|nslookup|host)\b|\bgit\s+(?:clone|fetch|pull|push|ls-remote|remote\s+update)\b/;

export const TERMINAL_INSTRUCTIONS =
  'terminal runs a shell command in an isolated sandbox with the repository mounted at /workspace and no network. ' +
  'toolCall.name "terminal"; toolCall.action is "<tool> <json>": terminal {"command":"ls -la src","timeout":120,' +
  '"workdir":"/workspace","background":false} or process_manage {"action":"list|poll|log|wait|kill","session_id":"bg-...",' +
  '"timeout":30}. The working directory persists between calls. Example: terminal {"command":"cat package.json"}.';

export const TERMINAL_ROUTING_TEXT =
  "terminal shell bash command line: run a command, execute a script, npm test, build, list files, " +
  "cat print a file, grep, git status, run tests in the sandbox, manage a background process.";

/**
 * A timeout that kills the whole process GROUP. busybox/GNU `timeout` signals only its direct
 * child, so a forked `sleep` survived, kept the stdout pipe open and `docker exec` never
 * returned. The command runs as its own session leader (`setsid`), a watchdog session kills
 * that group at the deadline, and the watchdog's own group is killed when the command finishes.
 */
function withGroupTimeout(inner: string, timeoutS: number): string {
  return [
    `setsid sh -c ${shellQuote(inner)} & __p=$!`,
    `setsid sh -c 'sleep ${timeoutS}; kill -9 -- -'"$__p"' 2>/dev/null; kill -9 '"$__p"' 2>/dev/null' & __w=$!`,
    "wait $__p; __rc=$?",
    "kill -9 -- -$__w 2>/dev/null; kill -9 $__w 2>/dev/null",
    "exit $__rc",
  ].join("\n");
}

export function createTerminalAdapter(ctx: ToolContext, sandbox: Sandbox = createSandbox(ctx)): TrentToolAdapter {
  const processes = new ProcessRegistry(sandbox, ctx.profileDir);
  let cwd = sandbox.workspaceRoot;
  const fail = (action: string, summary: string): ToolCallRecord => record(TERMINAL_NAME, action, "failed", summary);

  function resolveWorkdir(input: string | undefined): string {
    if (!input) return cwd;
    if (input.startsWith("/")) return input;
    return `${sandbox.workspaceRoot}/${input.replace(/^\.\/?/, "")}`.replace(/\/+$/, "") || sandbox.workspaceRoot;
  }

  function findings(command: string): string[] {
    const found = dangerous(command);
    for (const [re, label] of ALWAYS_APPROVE) {
      if (re.test(command) && !found.some((f) => f.includes(label))) found.push(`${label} (always requires approval)`);
    }
    return found;
  }

  async function runTerminal(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const command = stringArg(args, "command");
    if (!command) return fail(action, 'terminal needs {"command": "..."} plus optional timeout, workdir, background');
    const floor = floorBlock(command);
    if (floor !== null) {
      return record(TERMINAL_NAME, action, "blocked", `Blocked by the hardline floor: ${floor}. This command never runs, whatever the approval state.`);
    }
    const workdir = resolveWorkdir(stringArg(args, "workdir"));
    const network = args.network === true || NEEDS_EGRESS.test(command);
    const useEgress = network && ctx.egress !== undefined;

    if (args.background === true) {
      const proc = await processes.start(command, workdir, useEgress);
      return record(TERMINAL_NAME, action, "completed", `Started background process session_id=${proc.id} (pid ${proc.pid}) in ${workdir}. Use process_manage to poll, wait, read the log or kill it.`);
    }

    const timeoutS = intArg(args.timeout, DEFAULT_TIMEOUT_S, 1, MAX_TIMEOUT_S);
    const inner = `${command}\n__trent_rc=$?; printf '\\n${PWD_MARKER}%s${PWD_MARKER_END}\\n' "$(pwd -P)"; exit $__trent_rc`;
    const wrapped = sandbox.kind === "docker" ? withGroupTimeout(inner, timeoutS) : inner;
    const res = await sandbox.run(wrapped, { cwd: workdir, timeoutMs: timeoutS * 1000 + 500, network: useEgress });

    let stdout = res.stdout;
    const marker = new RegExp(`\\n?${PWD_MARKER}(.*)${PWD_MARKER_END}\\n?$`).exec(stdout);
    if (marker) {
      cwd = marker[1]!.trim() || cwd;
      stdout = stdout.slice(0, marker.index);
    }
    const timedOut = (res.exitCode === 124 || res.exitCode === 137 || res.exitCode === 143 || res.exitCode !== 0) && res.durationMs >= timeoutS * 1000;
    const output = stdout + (res.stderr.trim() ? `${stdout && !stdout.endsWith("\n") ? "\n" : ""}[stderr]\n${res.stderr}` : "");
    const noteParts = [
      network && !useEgress ? "[no network: this sandbox has no egress configured]" : "",
      timedOut ? `[timed out after ${timeoutS}s]` : res.exitCode !== 0 ? `[exit code ${res.exitCode}]` : "",
    ].filter(Boolean);
    const body = fitSummary(output.trimEnd() || "(no output)", ctx.profileDir, "terminal");
    const summary = noteParts.length ? `${body}\n${noteParts.join(" ")}` : body;
    return record(TERMINAL_NAME, action, timedOut ? "failed" : "completed", summary);
  }

  async function manage(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const op = stringArg(args, "action") ?? "list";
    if (op === "list") {
      const rows = processes.list().map((p) => `${p.id}\tpid ${p.pid}\t${p.startedAt}\t${p.command.slice(0, 120)}`);
      return record(TERMINAL_NAME, action, "completed", rows.length ? `session_id\tpid\tstarted\tcommand\n${rows.join("\n")}` : "(no background processes)");
    }
    const id = stringArg(args, "session_id");
    const proc: BackgroundProcess | undefined = id ? processes.get(id) : undefined;
    if (!proc) return fail(action, `process_manage ${op} needs a known session_id; known: ${processes.list().map((p) => p.id).join(", ") || "none"}`);
    switch (op) {
      case "poll":
      case "log":
      case "wait": {
        const status = op === "wait" ? await processes.wait(proc, intArg(args.timeout, 30, 1, MAX_TIMEOUT_S) * 1000) : await processes.status(proc);
        const state = status.running ? "running" : `exited${status.exitCode !== undefined ? ` with code ${status.exitCode}` : ""}`;
        const log = op === "log" ? status.log : headTail(status.log, 4_000, 0.2);
        return record(TERMINAL_NAME, action, "completed", fitSummary(`${proc.id} ${state}\n${log || "(no output yet)"}`, ctx.profileDir, proc.id));
      }
      case "kill":
        await processes.kill(proc);
        return record(TERMINAL_NAME, action, "completed", `${proc.id} (pid ${proc.pid}) killed`);
      default:
        return fail(action, `process_manage action "${op}" is not supported here; use list, poll, log, wait or kill`);
    }
  }

  return {
    name: TERMINAL_NAME,
    scopes: [...TERMINAL_SCOPES],
    availability: "real",
    instructions: TERMINAL_INSTRUCTIONS,
    routingText: TERMINAL_ROUTING_TEXT,
    async healthCheck() {
      return "connected";
    },
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error || parsed.tool !== "terminal") return false;
      const command = stringArg(parsed.args, "command");
      if (!command || floorBlock(command) !== null) return false;
      return findings(command).length > 0;
    },
    async dryRun(action) {
      const parsed = parseAction(action, SPECS);
      const command = stringArg(parsed.args, "command") ?? "";
      const list = findings(command).map((f, i) => `${i + 1}. ${f}`).join("\n");
      return record(TERMINAL_NAME, action, "needs_approval", `terminal command needs approval before it runs:\n${command}\nFindings:\n${list}`);
    },
    async execute(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error) return fail(action, parsed.error);
      try {
        return parsed.tool === "terminal" ? await runTerminal(action, parsed.args) : await manage(action, parsed.args);
      } catch (error) {
        return fail(action, `terminal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    containerNames: () => sandbox.containerNames(),
    cleanup: async () => {
      await processes.killAll();
      await sandbox.cleanup();
    },
  } as TrentToolAdapter & { containerNames(): string[] };
}
