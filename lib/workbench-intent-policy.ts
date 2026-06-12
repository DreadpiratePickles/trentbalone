/**
 * workbench-intent-policy.ts — task-scope contract for Workbench runs
 * (Fix Plan Slice 3, RC3).
 *
 * Testers showed Workbench mutating src/App.tsx, booting dev servers, and
 * scaffolding starter templates for prompts that asked for a single analysis
 * file or a bounded command-recovery demo. The model must not get write or
 * shell authority the request never granted. This module classifies the
 * objective and derives an enforceable action policy; the build loop enforces
 * it in code, not prompt hope.
 *
 * Pure module: no store, no provider, fully unit-testable.
 */

export type WorkbenchIntent =
  | "build"
  | "analysis"
  | "research"
  | "commandRecovery"
  | "deploymentPlan"
  | "artifactOnly";

export type WorkbenchScopePolicy = {
  intent: WorkbenchIntent;
  /** Starter-template scaffold + npm install allowed before the first attempt. */
  allowScaffold: boolean;
  /** Writes to app source/config (src/**, package.json, configs) allowed. */
  allowSourceEdits: boolean;
  /** Dev-server / preview `start` actions allowed. */
  allowDevServer: boolean;
  /** Mutating shell commands (install/build/rm/git commit…) allowed. */
  allowMutatingShell: boolean;
  /** Filenames explicitly requested as deliverables — always writable. */
  namedDeliverables: string[];
};

const FILE_MENTION = /\b([\w][\w.-]*\.(?:md|txt|csv|json|html))\b/gi;

/** Filenames the user explicitly asked to create ("create a file called X", "save it as X"). */
export function extractNamedDeliverables(objective: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (objective ?? "").matchAll(FILE_MENTION)) {
    const f = m[1].toLowerCase();
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

export function classifyWorkbenchIntent(objective: string): WorkbenchIntent {
  const text = (objective ?? "").toLowerCase();

  // Bounded failure/recovery demos: run a command, explain, recover, note.
  if (
    /\b(invalid|failing|deliberately|intentionally)\b[^.]*\bcommand\b/.test(text) ||
    (/\brecover\b/.test(text) && /\bcommand\b/.test(text))
  ) {
    return "commandRecovery";
  }

  // Deployment planning without deploying. Requires positive plan intent —
  // a bare "do not deploy anything" boundary must NOT classify as deploymentPlan.
  if (
    /\b(deployment|deploy|hosting)\s+(plan|checklist|strategy)\b/.test(text) ||
    (/\b(railway|vercel|render|fly\.io|netlify)\b/.test(text) && /\b(plan|checklist|prepare)\b/.test(text))
  ) {
    return "deploymentPlan";
  }

  // Research over data/files/web.
  if (/\b(research|analy[sz]|investigate|compare|study)/.test(text) && !/\b(build|implement|create an? app|prototype)\b/.test(text)) {
    return "research";
  }

  // Analysis / inspection / planning deliverables — read plus one report file.
  const analysisVerb = /\b(inspect|audit|review|summari[sz]e|assess|evaluate|identify|list|document)\b/.test(text);
  const buildVerb = /\b(build|implement|create|make|add|fix|scaffold|prototype|landing page|component|app|feature|ship)\b/.test(text);
  const planDeliverable = /\b(test plan|qa checklist|risks|implementation plan|plan\b)/.test(text);
  const noChanges = /\b(do not (make|deploy|change)|don't (make|deploy|change)|no changes|read.?only|analysis only)\b/.test(text);

  if (noChanges && !/\b(landing page|prototype|component)\b/.test(text)) {
    return analysisVerb || planDeliverable ? "analysis" : "artifactOnly";
  }
  if (analysisVerb && planDeliverable && !buildVerb) return "analysis";
  if (!buildVerb && extractNamedDeliverables(text).length > 0) return "artifactOnly";
  return "build";
}

export function deriveWorkbenchScopePolicy(objective: string): WorkbenchScopePolicy {
  const intent = classifyWorkbenchIntent(objective);
  const namedDeliverables = extractNamedDeliverables(objective);
  const isBuild = intent === "build";
  return {
    intent,
    allowScaffold: isBuild,
    allowSourceEdits: isBuild,
    allowDevServer: isBuild,
    allowMutatingShell: isBuild || intent === "commandRecovery",
    namedDeliverables,
  };
}

/** App source / dependency / config paths protected outside build intent. */
const PROTECTED_PATH = /^(src\/|app\/|components\/|lib\/|pages\/|package(-lock)?\.json$|tsconfig|vite\.config|next\.config|tailwind\.config|postcss\.config|index\.html$)/i;

export function checkWriteAllowed(
  policy: WorkbenchScopePolicy,
  filePath: string,
): { allowed: boolean; reason?: string } {
  if (policy.allowSourceEdits) return { allowed: true };
  const normalized = filePath.replace(/^\.\//, "").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  if (policy.namedDeliverables.includes(base) || policy.namedDeliverables.includes(normalized)) {
    return { allowed: true };
  }
  if (policy.intent === "deploymentPlan") {
    return {
      allowed: false,
      reason: `out-of-scope: deploymentPlan task is read-only unless the user names a deliverable (${filePath}).`,
    };
  }
  if (PROTECTED_PATH.test(normalized)) {
    return {
      allowed: false,
      reason: `out-of-scope: ${policy.intent} task may not modify app source/config (${filePath}). Requested deliverables: ${policy.namedDeliverables.join(", ") || "none"}.`,
    };
  }
  // Non-protected, non-named files (notes, reports) are allowed for
  // analysis/research/recovery — agents legitimately produce report files.
  return { allowed: true };
}

/**
 * Markdown / prose / checklist detection for shell actions. Tester evidence:
 * the verifier sent lines beginning with `#` to the executor and burned
 * repair cycles on "Executable '#' is not in the allowed list".
 */
export function isProseCommand(command: string): boolean {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return true;
  if (/^(#|\/\/|--\s|\*|>|`)/.test(trimmed)) return true;       // comments / markdown markers
  if (/^[-*+]\s/.test(trimmed)) return true;                      // bullets
  if (/^\d+[.)]\s/.test(trimmed)) return true;                    // numbered checklist
  if (/^\[[ xX]?\]/.test(trimmed)) return true;                   // checkbox
  if (/[:?]$/.test(trimmed) && !/[|&;]/.test(trimmed)) return true; // headings / questions
  const firstToken = trimmed.split(/\s+/)[0];
  if (!/^[A-Za-z0-9_./-]+$/.test(firstToken)) return true;        // not an executable shape
  return false;
}

const DEV_SERVER_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|preview)\b|\bvite\b|\bnext\s+dev\b/;
const MUTATING_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|run\s+build)\b|\brm\b|\bmv\b|\bgit\s+(commit|push|reset|checkout)\b|\bnpx\s+(prisma|tsc\s+--build)\b|>\s*\S|>>\s*\S/;

export type ActionDecision = { allowed: boolean; note?: string };

/** Gate a parsed agent action against the scope policy before execution. */
export function checkActionAgainstPolicy(
  policy: WorkbenchScopePolicy,
  action: { type: "file" | "edit" | "shell" | "start"; filePath?: string; command?: string },
): ActionDecision {
  if (action.type === "file" || action.type === "edit") {
    const verdict = checkWriteAllowed(policy, action.filePath ?? "");
    return verdict.allowed
      ? { allowed: true }
      : { allowed: false, note: `Blocked write: ${verdict.reason}` };
  }
  const command = action.command ?? "";
  if (isProseCommand(command)) {
    return { allowed: false, note: `Skipped non-command text (treated as note): ${command.slice(0, 120)}` };
  }
  if (action.type === "start" && !policy.allowDevServer) {
    return { allowed: false, note: `Blocked dev server start for ${policy.intent} task: ${command}` };
  }
  if (action.type === "shell" && !policy.allowMutatingShell && (MUTATING_COMMAND.test(command) || DEV_SERVER_COMMAND.test(command))) {
    return { allowed: false, note: `Blocked mutating command for read-only ${policy.intent} task: ${command}` };
  }
  return { allowed: true };
}
