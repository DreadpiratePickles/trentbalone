import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord, WorkbenchCheckpoint, WorkbenchSession } from "@/lib/types";
import { resolveWorkbenchProviderCredentialEnv } from "@/lib/credential-boundary";
import { createWorkbenchSession, type WorkbenchCreateInput } from "@/lib/workbench";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { store } from "@/lib/store";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

export type WorkbenchSandboxToolAdapterOptions = {
  env?: EnvLike;
  createSessionFn?: (input: WorkbenchCreateInput) => Promise<WorkbenchSession>;
  upsertCheckpointFn?: (input: Omit<WorkbenchCheckpoint, "id" | "updatedAt">) => Promise<WorkbenchCheckpoint | undefined>;
  getProviderFn?: (name?: string) => WorkbenchProviderAdapter;
  resolveCredentialEnvFn?: typeof resolveWorkbenchProviderCredentialEnv;
};

type WorkbenchSessionToolAction = {
  objective?: string;
  writeFiles: Array<{ path: string; content: string }>;
  command: string;
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
  const upsertCheckpointFn = options.upsertCheckpointFn
    ?? (typeof store.upsertWorkbenchCheckpoint === "function"
      ? store.upsertWorkbenchCheckpoint.bind(store)
      : async () => undefined);
  const getProviderFn = options.getProviderFn ?? getWorkbenchProvider;
  const resolveCredentialEnvFn = options.resolveCredentialEnvFn ?? resolveWorkbenchProviderCredentialEnv;
  const realProvider = hasPotentialRealSandboxProvider(env);
  const availability = realProvider ? "real" : env.NODE_ENV === "production" ? "unavailable" : "test_only";

  return {
    name: "Workbench Sandbox",
    scopes: ["sandbox:exec", "workbench:session", "tests:run", "code:execute"],
    availability,
    async healthCheck(companyId?: string) {
      const readiness = await sandboxProviderHealth(env, companyId, resolveCredentialEnvFn);
      if (readiness === "connected") return "connected";
      if (readiness === "needs_credentials") return "needs_credentials";
      return env.NODE_ENV === "production" ? "needs_credentials" : "mocked";
    },
    estimateCost() {
      return realProvider ? 5 : 0;
    },
    requiresApproval(action) {
      return APPROVAL_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      const companyId = typeof payload.companyId === "string" && payload.companyId.trim() ? payload.companyId.trim() : undefined;
      const readiness = await sandboxProviderHealth(env, companyId, resolveCredentialEnvFn);
      if (readiness === "needs_credentials" && env.NODE_ENV === "production") {
        return failed(action, "Workbench Sandbox is not configured. Set DAYTONA_API_KEY or E2B_API_KEY before agents can execute code in production.");
      }
      const sessionAction = parseWorkbenchSessionToolAction(action);
      const approvalSubject = sessionAction ? `${sessionAction.command}\n${sessionAction.writeFiles.map((file) => file.path).join("\n")}` : action;
      if (this.requiresApproval(approvalSubject) && typeof payload.approvalId !== "string") {
        return {
          adapter: "Workbench Sandbox",
          action,
          status: "needs_approval",
          summary: `Workbench Sandbox action "${action}" requires approval before side-effecting execution.`,
        };
      }

      if (sessionAction) {
        return executeWorkbenchSessionAction({
          action,
          sessionAction,
          payload,
          createSessionFn,
          upsertCheckpointFn,
          getProviderFn,
        });
      }

      const command = typeof payload.command === "string" && payload.command.trim()
        ? resolveSandboxExecCommand(`exec: ${payload.command}`)
        : resolveSandboxExecCommand(action);
      if (!command) {
        return failed(action, `Sandbox command is not allowlisted. Supported actions include run tests, run typecheck, run build, lint, pwd, ls, find, and cat package.json/README.md.`);
      }

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
        const activeSession = await startAndPersistWorkbenchSession(session, provider, upsertCheckpointFn);
        const result = await provider.exec(activeSession, command, { timeoutMs: timeoutForCommand(command) });
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

async function executeWorkbenchSessionAction(input: {
  action: string;
  sessionAction: WorkbenchSessionToolAction;
  payload: Record<string, unknown>;
  createSessionFn: (input: WorkbenchCreateInput) => Promise<WorkbenchSession>;
  upsertCheckpointFn: (input: Omit<WorkbenchCheckpoint, "id" | "updatedAt">) => Promise<WorkbenchCheckpoint | undefined>;
  getProviderFn: (name?: string) => WorkbenchProviderAdapter;
}): Promise<ToolCallRecord> {
  const companyId = typeof input.payload.companyId === "string" && input.payload.companyId.trim()
    ? input.payload.companyId.trim()
    : undefined;
  if (!companyId) {
    return failed(input.action, "Workbench Sandbox session execution requires payload.companyId.");
  }

  const command = resolveSandboxExecCommand(`exec: ${input.sessionAction.command}`);
  if (!command) {
    return failed(input.action, "Workbench Sandbox session command is not allowlisted.");
  }

  const fileError = validateWorkbenchWriteFiles(input.sessionAction.writeFiles);
  if (fileError) return failed(input.action, fileError);

  try {
    const session = await input.createSessionFn({
      companyId,
      objective: input.sessionAction.objective?.trim() || `Seat workbench session: ${command}`,
      agentRole: "engineer",
      agentMode: "build",
      provider: input.payload.provider as WorkbenchCreateInput["provider"],
      enqueue: false,
    });
    const provider = input.getProviderFn(session.provider);
    const activeSession = await startAndPersistWorkbenchSession(session, provider, input.upsertCheckpointFn);
    const before = provider.snapshot ? await provider.snapshot(activeSession).catch(() => undefined) : undefined;
    for (const file of input.sessionAction.writeFiles) {
      await provider.writeFile(activeSession, file.path, file.content);
    }
    const result = await provider.exec(activeSession, command, { timeoutMs: timeoutForCommand(command) });
    const diff = provider.diffSinceCheckpoint
      ? await provider.diffSinceCheckpoint(activeSession, before?.fileTreeHash ?? before?.id).catch(() => undefined)
      : undefined;
    const status = result.exitCode === 0 ? "completed" : "failed";
    const changedPaths = diff?.changedPaths.length
      ? diff.changedPaths
      : input.sessionAction.writeFiles.map((file) => file.path);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 900);
    const patch = diff?.patch ? `\n${diff.patch.slice(0, 1600)}` : "";
    const diffSummary = diff?.summary ?? `${changedPaths.length} file(s) written`;
    return {
      adapter: "Workbench Sandbox",
      action: input.action,
      status,
      summary: [
        `Workbench Sandbox session ${session.id} wrote ${changedPaths.join(", ")}.`,
        `Ran \`${command}\` with exit code ${result.exitCode}.`,
        `Diff: ${diffSummary}.${patch}`,
        output ? `Output:\n${output}` : "",
      ].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return failed(input.action, `Workbench Sandbox session execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startAndPersistWorkbenchSession(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  upsertCheckpointFn: (input: Omit<WorkbenchCheckpoint, "id" | "updatedAt">) => Promise<WorkbenchCheckpoint | undefined>,
): Promise<WorkbenchSession> {
  const handle = await provider.start(session);
  if (!handle) return session;
  const checkpoint = await upsertCheckpointFn({
    companyId: session.companyId,
    sessionId: session.id,
    provider: handle.provider ?? session.provider,
    providerSessionId: handle.providerSessionId,
    workdir: handle.workdir,
    previewUrl: handle.providerUrl,
    sandboxExpiresAt: handle.expiresAt,
  }).catch(() => undefined);
  return {
    ...session,
    workdir: checkpoint?.workdir ?? handle.workdir ?? session.workdir,
    previewUrl: checkpoint?.previewUrl ?? handle.providerUrl ?? session.previewUrl,
  };
}

function parseWorkbenchSessionToolAction(action: string): WorkbenchSessionToolAction | undefined {
  const raw = action.replace(/^\s*workbench:session\s*:?/i, "").trim();
  if (!raw.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.toLowerCase() : "";
  if (kind && kind !== "workbench:session") return undefined;
  const writeFiles = Array.isArray(record.writeFiles)
    ? record.writeFiles.flatMap((item) => normalizeWriteFile(item))
    : [];
  if (!writeFiles.length) return undefined;
  return {
    objective: typeof record.objective === "string" ? record.objective : undefined,
    writeFiles,
    command: typeof record.command === "string" && record.command.trim() ? record.command.trim() : "npm test",
  };
}

function normalizeWriteFile(item: unknown): Array<{ path: string; content: string }> {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.content !== "string") return [];
  return [{ path: record.path, content: record.content }];
}

function validateWorkbenchWriteFiles(files: Array<{ path: string; content: string }>): string | undefined {
  if (!files.length) return "Workbench Sandbox session requires at least one file write.";
  if (files.length > 8) return "Workbench Sandbox session can write at most 8 files per tool call.";
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/").trim();
    if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
      return `Workbench Sandbox refused unsafe path "${file.path}".`;
    }
    if (normalized.split("/").some((part) => part === "..")) {
      return `Workbench Sandbox refused path traversal in "${file.path}".`;
    }
    if (file.content.length > 50_000) {
      return `Workbench Sandbox refused oversized file "${file.path}".`;
    }
    file.path = normalized;
  }
  return undefined;
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

type SandboxProviderName = "e2b" | "daytona" | "railway" | "mock_local";
type SandboxCredentialResolver = typeof resolveWorkbenchProviderCredentialEnv;

function explicitSandboxProvider(env: EnvLike): string | undefined {
  return env.WORKBENCH_DEFAULT_PROVIDER?.trim().toLowerCase() || undefined;
}

function hasPotentialRealSandboxProvider(env: EnvLike) {
  const provider = explicitSandboxProvider(env);
  return Boolean(
    env.DAYTONA_API_KEY
    || env.E2B_API_KEY
    || env.RAILWAY_ENVIRONMENT
    || provider === "railway"
    || provider === "daytona"
    || provider === "e2b",
  );
}

async function sandboxProviderHealth(
  env: EnvLike,
  companyId: string | undefined,
  resolveCredentialEnvFn: SandboxCredentialResolver,
): Promise<"connected" | "needs_credentials" | "mocked"> {
  const provider = explicitSandboxProvider(env);
  if (provider === "railway" || (!provider && env.RAILWAY_ENVIRONMENT)) return "connected";
  if (provider === "e2b" || provider === "daytona") {
    return await hasCredentialsForProvider(provider, env, companyId, resolveCredentialEnvFn)
      ? "connected"
      : "needs_credentials";
  }
  if (provider && provider !== "mock_local") return "needs_credentials";
  if (env.E2B_API_KEY || env.DAYTONA_API_KEY) return "connected";
  return env.NODE_ENV === "production" ? "needs_credentials" : "mocked";
}

async function hasCredentialsForProvider(
  provider: Extract<SandboxProviderName, "e2b" | "daytona">,
  env: EnvLike,
  companyId: string | undefined,
  resolveCredentialEnvFn: SandboxCredentialResolver,
) {
  if (provider === "e2b" && env.E2B_API_KEY) return true;
  if (provider === "daytona" && env.DAYTONA_API_KEY) return true;
  if (!companyId) return false;
  try {
    const credentials = await resolveCredentialEnvFn(companyId, provider);
    return credentials.source !== "missing";
  } catch {
    return false;
  }
}

function timeoutForCommand(command: string) {
  if (/typecheck|build|test/i.test(command)) return 120_000;
  return 30_000;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Workbench Sandbox", action, status: "failed", summary };
}
