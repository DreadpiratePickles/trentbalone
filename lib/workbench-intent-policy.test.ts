import { describe, expect, it } from "vitest";
import {
  checkActionAgainstPolicy,
  checkWriteAllowed,
  classifyWorkbenchIntent,
  deriveWorkbenchScopePolicy,
  extractNamedDeliverables,
  isProseCommand,
} from "@/lib/workbench-intent-policy";

// Exact tester prompts that failed (Workbench tests 1, 2, 4, 5, research).
const TEST_PLAN_PROMPT =
  "Inspect the uploaded technical architecture and product feature inventory. Create a file called trent-test-plan.md summarizing the top engineering risks, recommended test commands, and a short manual QA checklist. Do not deploy anything.";
const RECOVERY_PROMPT =
  "Run a deliberately invalid command, explain the failure, recover with a corrected command, and write a short failure-recovery note.";
const RAILWAY_PROMPT =
  "Prepare a Railway deployment plan for this app. Do not deploy. List every step that requires founder approval, every required environment variable, and a rollback plan.";
const LANDING_PROMPT =
  "Using the brand voice and marketing plan, create a minimal landing page prototype for this app. Include copy, layout notes, and a README. Run a basic verification command and report the result.";
const RESEARCH_PROMPT =
  "Analyze customers.csv, support-tickets.csv, and analytics.json. Produce a concise operator report with findings, metric risks, support risks, and next actions. Save it as operator-report.md.";

describe("classifyWorkbenchIntent", () => {
  it("treats inspect-and-write-one-file prompts as analysis", () => {
    expect(classifyWorkbenchIntent(TEST_PLAN_PROMPT)).toBe("analysis");
  });
  it("detects command recovery", () => {
    expect(classifyWorkbenchIntent(RECOVERY_PROMPT)).toBe("commandRecovery");
  });
  it("detects deployment planning", () => {
    expect(classifyWorkbenchIntent(RAILWAY_PROMPT)).toBe("deploymentPlan");
  });
  it("keeps real build prompts as build", () => {
    expect(classifyWorkbenchIntent(LANDING_PROMPT)).toBe("build");
  });
  it("detects research over named files", () => {
    expect(classifyWorkbenchIntent(RESEARCH_PROMPT)).toBe("research");
  });
});

describe("deriveWorkbenchScopePolicy", () => {
  it("analysis tasks get no scaffold, no src edits, no dev server", () => {
    const p = deriveWorkbenchScopePolicy(TEST_PLAN_PROMPT);
    expect(p.allowScaffold).toBe(false);
    expect(p.allowSourceEdits).toBe(false);
    expect(p.allowDevServer).toBe(false);
    expect(p.namedDeliverables).toContain("trent-test-plan.md");
  });
  it("command recovery may run mutating shell but not edit source", () => {
    const p = deriveWorkbenchScopePolicy(RECOVERY_PROMPT);
    expect(p.allowMutatingShell).toBe(true);
    expect(p.allowSourceEdits).toBe(false);
    expect(p.allowDevServer).toBe(false);
  });
  it("build tasks keep full authority", () => {
    const p = deriveWorkbenchScopePolicy(LANDING_PROMPT);
    expect(p.allowScaffold).toBe(true);
    expect(p.allowSourceEdits).toBe(true);
    expect(p.allowDevServer).toBe(true);
  });
});

describe("checkWriteAllowed", () => {
  const policy = deriveWorkbenchScopePolicy(TEST_PLAN_PROMPT);
  it("allows the named deliverable", () => {
    expect(checkWriteAllowed(policy, "trent-test-plan.md").allowed).toBe(true);
  });
  it("blocks src/App.tsx for analysis tasks (tester regression)", () => {
    const verdict = checkWriteAllowed(policy, "src/App.tsx");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("out-of-scope");
  });
  it("blocks package.json outside build intent (recovery regression)", () => {
    const recovery = deriveWorkbenchScopePolicy(RECOVERY_PROMPT);
    expect(checkWriteAllowed(recovery, "package.json").allowed).toBe(false);
  });
  it("allows incidental note files", () => {
    expect(checkWriteAllowed(policy, "notes/findings.md").allowed).toBe(true);
  });
  it("blocks deployment-plan file writes unless the user named a deliverable", () => {
    const deployment = deriveWorkbenchScopePolicy(RAILWAY_PROMPT);
    const verdict = checkWriteAllowed(deployment, "railway-deployment-plan.md");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("deploymentPlan task is read-only");
  });
});

describe("isProseCommand", () => {
  it("rejects markdown/comment/checklist lines (tester regression: '#' executed)", () => {
    for (const line of [
      "# Verify the build",
      "- npm run dev",
      "* check preview",
      "> quote",
      "1. run tests",
      "[ ] verify output",
      "Verification checklist:",
      "",
    ]) {
      expect(isProseCommand(line), JSON.stringify(line)).toBe(true);
    }
  });
  it("accepts real commands", () => {
    for (const line of ["npm install --legacy-peer-deps", "npx tsc --noEmit", "ls -la", "node script.js"]) {
      expect(isProseCommand(line), line).toBe(false);
    }
  });
});

describe("checkActionAgainstPolicy", () => {
  const analysis = deriveWorkbenchScopePolicy(TEST_PLAN_PROMPT);
  it("blocks dev-server starts for analysis tasks", () => {
    const d = checkActionAgainstPolicy(analysis, { type: "start", command: "npm run dev" });
    expect(d.allowed).toBe(false);
  });
  it("blocks mutating shell for read-only intents", () => {
    const d = checkActionAgainstPolicy(analysis, { type: "shell", command: "npm install lodash" });
    expect(d.allowed).toBe(false);
  });
  it("allows read-only inspection commands", () => {
    const d = checkActionAgainstPolicy(analysis, { type: "shell", command: "cat package.json" });
    expect(d.allowed).toBe(true);
  });
  it("converts prose shell lines into skipped notes, not failures", () => {
    const d = checkActionAgainstPolicy(analysis, { type: "shell", command: "# manual QA checklist" });
    expect(d.allowed).toBe(false);
    expect(d.note).toContain("non-command text");
  });
  it("lets build tasks start dev servers", () => {
    const build = deriveWorkbenchScopePolicy(LANDING_PROMPT);
    expect(checkActionAgainstPolicy(build, { type: "start", command: "npm run dev" }).allowed).toBe(true);
  });
});
