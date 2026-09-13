/**
 * `code_execution`: Hermes's `execute_code` over the seat's sandbox — the same Docker container
 * (cap-drop ALL, no network) or the same scrubbed-env `LocalBackend` that `terminal` uses, so a
 * snippet reading `os.environ` / `process.env` sees nothing the host was holding.
 *
 * The interpreter is `exec`'d so the shell is replaced: a timeout kill lands on the interpreter
 * itself, not on a parent shell that would leave it orphaned. On Docker the whole process group
 * is killed (`withGroupTimeout`), exactly as `terminal` does.
 *
 * Approval floor is `terminal`'s: `floorBlock` over the source inside `execute`, every dangerous
 * finding plus the always-approve list merged into one `needs_approval`.
 */
import { intArg, parseAction, record, stringArg, type ToolSpec } from "../action.js";
import { dangerous, floorBlock } from "../approval-floors.js";
import { createSandbox, shellQuote, type Sandbox } from "../sandbox.js";
import { fitSummary } from "../spillover.js";
import { ALWAYS_APPROVE, withGroupTimeout } from "../terminal/adapter.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { renderToolInstructions } from "../web/schemas.js";
import { CODE_DEFAULT_TIMEOUT_S, CODE_EXECUTION_SCHEMAS, CODE_LANGUAGES, CODE_MAX_TIMEOUT_S, type CodeLanguage } from "./schemas.js";

export { CODE_EXECUTION_SCHEMAS, CODE_LANGUAGES, CODE_DEFAULT_TIMEOUT_S, CODE_MAX_TIMEOUT_S } from "./schemas.js";

export const CODE_EXECUTION_NAME = "code_execution";
export const CODE_EXECUTION_SCOPES = ["code_execution", "execute_code"];
export const CODE_EXECUTION_ROUTING_TEXT =
  "execute code, run a python script, run javascript, node snippet, compute over many files, " +
  "parse and filter large output with a program, loop over results, quick calculation";

const SPECS: readonly ToolSpec[] = [{ name: "execute_code", primary: "code", signature: ["code"] }];
const INTERPRETERS: Readonly<Record<CodeLanguage, readonly string[]>> = {
  python: ["python3", "-c"],
  javascript: ["node", "-e"],
};

function isLanguage(value: unknown): value is CodeLanguage {
  return typeof value === "string" && (CODE_LANGUAGES as readonly string[]).includes(value);
}

/** Every finding one approval request must list: dangerous patterns plus the always-approve list. */
export function codeFindings(code: string): string[] {
  const found = dangerous(code);
  for (const [re, label] of ALWAYS_APPROVE) {
    if (re.test(code) && !found.some((f) => f.includes(label))) found.push(`${label} (always requires approval)`);
  }
  return found;
}

/** `exec python3 -c '<code>'`: the interpreter replaces the shell, so a kill reaches it directly. */
export function interpreterCommand(language: CodeLanguage, code: string): string {
  const [bin, flag] = INTERPRETERS[language];
  return `exec ${bin} ${flag} ${shellQuote(code)}`;
}

/** Node's `exec` puts the whole command line in `error.message` when stderr is empty; never echo the source back. */
function cleanStderr(stderr: string): string {
  return stderr.startsWith("Command failed: ") ? "" : stderr;
}

export function createCodeExecutionAdapter(ctx: ToolContext, sandbox: Sandbox = createSandbox(ctx)): TrentToolAdapter {
  const fail = (action: string, summary: string): ToolCallRecord => record(CODE_EXECUTION_NAME, action, "failed", summary);

  async function run(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const code = stringArg(args, "code");
    if (!code || !code.trim()) {
      const hint = "command" in args ? " (you passed \"command\"; that is terminal's argument)" : "";
      return fail(action, `execute_code needs {"code": "..."} plus optional language, timeout${hint}.`);
    }
    const language = args.language === undefined ? "python" : args.language;
    if (!isLanguage(language)) return fail(action, `execute_code language must be one of ${CODE_LANGUAGES.join(", ")}.`);
    const floor = floorBlock(code);
    if (floor !== null) {
      return record(CODE_EXECUTION_NAME, action, "blocked", `Blocked by the hardline floor: ${floor}. This code never runs, whatever the approval state.`);
    }
    const timeoutS = intArg(args.timeout, CODE_DEFAULT_TIMEOUT_S, 1, CODE_MAX_TIMEOUT_S);
    const inner = interpreterCommand(language, code);
    const wrapped = sandbox.kind === "docker" ? withGroupTimeout(inner, timeoutS) : inner;
    const res = await sandbox.run(wrapped, { cwd: sandbox.workspaceRoot, timeoutMs: timeoutS * 1000, network: false });

    const timedOut = res.exitCode !== 0 && res.durationMs >= timeoutS * 1000;
    const stderr = cleanStderr(res.stderr);
    const missing = res.exitCode === 127 || /not found|No such file/i.test(stderr) && stderr.includes(INTERPRETERS[language][0]!);
    const output = res.stdout + (stderr.trim() ? `${res.stdout && !res.stdout.endsWith("\n") ? "\n" : ""}[stderr]\n${stderr}` : "");
    const note = timedOut
      ? `[timed_out: killed after ${timeoutS}s; no state survives]`
      : missing
        ? `[interpreter ${INTERPRETERS[language][0]} is not available in this sandbox]`
        : res.exitCode !== 0
          ? `[exit code ${res.exitCode}]`
          : "";
    const body = fitSummary(output.trimEnd() || "(no output)", ctx.profileDir, "execute_code");
    return record(CODE_EXECUTION_NAME, action, res.exitCode === 0 ? "completed" : "failed", note ? `${body}\n${note}` : body);
  }

  return {
    name: CODE_EXECUTION_NAME,
    scopes: [...CODE_EXECUTION_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(CODE_EXECUTION_SCHEMAS),
    routingText: CODE_EXECUTION_ROUTING_TEXT,
    async healthCheck() {
      return "connected";
    },
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error) return false;
      const code = stringArg(parsed.args, "code");
      if (!code || floorBlock(code) !== null) return false;
      return codeFindings(code).length > 0;
    },
    async dryRun(action) {
      const parsed = parseAction(action, SPECS);
      const code = stringArg(parsed.args, "code") ?? "";
      const list = codeFindings(code).map((f, i) => `${i + 1}. ${f}`).join("\n");
      return record(CODE_EXECUTION_NAME, action, "needs_approval", `execute_code needs approval before it runs (${code.length} chars of ${String(parsed.args.language ?? "python")}).\nFindings:\n${list}`);
    },
    async execute(action) {
      const parsed = parseAction(action, SPECS);
      if (parsed.error) return fail(action, parsed.error);
      try {
        return await run(action, parsed.args);
      } catch (error) {
        return fail(action, `execute_code failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    containerNames: () => sandbox.containerNames(),
    cleanup: () => sandbox.cleanup(),
  } as TrentToolAdapter & { containerNames(): string[] };
}
