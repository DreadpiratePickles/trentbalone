import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord, WorkbenchSession } from "@/lib/types";
import { createWorkbenchSession, type WorkbenchCreateInput } from "@/lib/workbench";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

export type WorkbenchSandboxToolAdapterOptions = {
  env?: EnvLike;
  createSessionFn?: (input: WorkbenchCreateInput) => Promise<WorkbenchSession>;
  getProviderFn?: (name?: string) => WorkbenchProviderAdapter;
};

const APPROVAL_ACTION_RE = /\b(git\s+push|commit|deploy|publish|curl|wget|rm\s+-|delete|secret|token|credential|login|purchase|submit)\b/i;
const SHELL_META_RE = /[;&|`$<>]/;
const SAFE_DIRECT_COMMANDS = [
  /^npm test(?:\s+--[\w:=@./+-]+)*$/i,
  /^npm run (?:test|typecheck|build|lint)(?:\s+--[\w:=@./+-]+)*$/i,
  /^pnpm (?:test|run (?:test|typecheck|build|lint))(?:\s+--[\w:=@./+-]+)*$/i,
  /^bun (?:test|run (?:test|typecheck|build|lint))(?:\s+--[\w:=@./+-]+)*$/i,
  /^pwd$/i,
  /^ls(?:\s+[-\w./]+)*$/i,
  /^cat\s+(?:package\.json|README\.md|readme\.md)$/i,
  /^find\s+\.(?:\s+[-\w./]+)*$/i,
];

export function createWorkbenchSandboxToolAdapter(options: WorkbenchSandboxToolAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const createSessionFn = options.createSessionFn ?? createWorkbenchSession;
  const getProviderFn = options.getProviderFn ?? getWorkbenchProvider;
  const realProvider = hasRealSandboxProvider(env);
  const availability = realProvider ? "real" : env.NODE_ENV === "production" ? "unavailable" : "test_only";

  return {
    name: "Workbench Sandbox",
    scopes: ["sandbox:exec", "workbench:session", "tests:run", "code:execute"],
    availability,
    async healthCheck() {
      if (realProvider) return "connected";
      return env.NODE_ENV === "production" ? "needs_credentials" : "mocked";
    },
    estimateCost() {
      return realProvider ? 5 : 0;
    },
    requiresApproval(action) {
      return APPROVAL_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      if (!hasRealSandboxProvider(env) && env.NODE_ENV === "production") {
        return failed(action, "Workbench Sandbox is not configured. Set DAYTONA_API_KEY or E2B_API_KEY before agents can execute code in production.");
      }
      if (this.requiresApproval(action) && typeof payload.approvalId !== "string") {
        return {
          adapter: "Workbench Sandbox",
          action,
          status: "needs_approval",
          summary: `Workbench Sandbox action "${action}" requires approval before side-effecting execution.`,
        };
      }

      const command = typeof payload.command === "string" && payload.command.trim()
        ? resolveSandboxExecCommand(`exec: ${payload.command}`)
        : resolveSandboxExecCommand(action);
      if (!command) {
        return failed(action, `Sandbox command is not allowlisted. Supported actions include run tests, run typecheck, run build, lint, pwd, ls, find, and cat package.json/README.md.`);
      }

      const companyId = typeof payload.companyId === "string" && payload.companyId.trim() ? payload.companyId.trim() : undefined;
      if (!companyId) {
        return failed(action, "Workbench Sandbox execution requires payload.companyId.");
      }

      try {
        const session = await createSessionFn({
          companyId,
          objective: `Seat sandbox execution: ${command}`,
          agentRole: "engineer",
          agentMode: "build",
          provider: payload.provider as WorkbenchCreateInput["provider"],
          enqueue: false,
        });
        const provider = getProviderFn(session.provider);
        await provider.start(session);
        const result = await provider.exec(session, command, { timeoutMs: timeoutForCommand(command) });
        const status = result.exitCode === 0 ? "completed" : "failed";
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 1200);
        return {
          adapter: "Workbench Sandbox",
          action,
          status,
          summary: `Workbench Sandbox session ${session.id} ran \`${command}\` with exit code ${result.exitCode}.${output ? `\n${output}` : ""}`,
        };
      } catch (error) {
        return failed(action, `Workbench Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      const command = resolveSandboxExecCommand(action);
      return {
        adapter: "Workbench Sandbox",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: command
          ? `Workbench Sandbox dry-run: Trent would run \`${command}\` inside an isolated workbench session.`
          : "Workbench Sandbox dry-run: requested command is not allowlisted.",
      };
    },
  };
}

export function resolveSandboxExecCommand(action: string): string | undefined {
  const raw = action.replace(/^\s*(?:exec|run|command)\s*:\s*/i, "").trim();
  const lower = raw.toLowerCase();

  if (/\btypecheck\b/.test(lower)) return "npm run typecheck";
  if (/\btests?\b/.test(lower)) return "npm test";
  if (/\bbuild\b/.test(lower)) return "npm run build";
  if (/\blint\b/.test(lower)) return "npm run lint";

  if (SHELL_META_RE.test(raw)) return undefined;
  if (SAFE_DIRECT_COMMANDS.some((pattern) => pattern.test(raw))) return raw;
  return undefined;
}

function hasRealSandboxProvider(env: EnvLike) {
  const configuredProvider = env.WORKBENCH_DEFAULT_PROVIDER?.trim();
  return Boolean(
    env.DAYTONA_API_KEY ||
    env.E2B_API_KEY ||
    (configuredProvider && configuredProvider !== "mock_local"),
  );
}

function timeoutForCommand(command: string) {
  if (/typecheck|build|test/i.test(command)) return 120_000;
  return 30_000;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Workbench Sandbox", action, status: "failed", summary };
}
