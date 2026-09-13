/**
 * The `cron` toolset: Hermes's `cronjob_manage` over `<profile>/cron/jobs.json`.
 *
 * This adapter WRITES the schedule. Nothing here ticks: a runner that reads jobs.json and
 * launches the prompt is a separate component, and every summary says so, so a seat never
 * believes a job it created has already run.
 *
 * Writes are temp-file-then-rename (0600), so a crash mid-write leaves the previous file whole.
 * The prompt is scanned for injection on create, update and run; a finding is `blocked`.
 * `create` with `terminal` in enabled_toolsets always requires approval.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "../../config/atomic-fs.js";
import { fitSummary } from "../spillover.js";
import { parseAction, record as toRecord, stringArg, type ToolSpec } from "../action.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { validateCronExpression } from "./cron-expression.js";
import { scanPromptForInjection } from "./prompt-scan.js";

export { validateCronExpression } from "./cron-expression.js";
export { scanPromptForInjection } from "./prompt-scan.js";

export const CRON_ADAPTER_NAME = "cron";
const SPECS: readonly ToolSpec[] = [{ name: "cronjob_manage", primary: "action", signature: ["action"] }];
const ROUTING_TEXT =
  "schedule a recurring job, cron, run this every day, weekly report, remind me, automate on a " +
  "schedule, pause or resume a scheduled task";

const argString = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = stringArg(args, key)?.trim();
  return v ? v : undefined;
};
const JOBS_FILE_MODE = 0o600;
const RUNNER_NOTE =
  "Note: this tool only writes the schedule. The cron runner is out of scope for this adapter and " +
  "does not run jobs from here; nothing has executed.";
const ACTIONS = ["create", "list", "update", "pause", "resume", "remove", "run"] as const;
type CronAction = (typeof ACTIONS)[number];
const EDITABLE = ["name", "schedule", "prompt", "deliver", "skills", "enabled_toolsets", "workdir"] as const;

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  deliver?: string;
  skills?: string[];
  enabled_toolsets?: string[];
  workdir?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  run_requested_at?: string;
}

export const CRON_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "cronjob_manage",
    description:
      "Create, list, update, pause, resume, remove or request a run of a scheduled job. Schedules are " +
      "five-field cron expressions or @hourly/@daily/@weekly/@monthly. Prompts are scanned for " +
      "injection and embedded credentials. This writes the schedule only; a separate runner executes it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        job_id: { type: "string", description: "Required for update, pause, resume, remove, run." },
        name: { type: "string" },
        schedule: { type: "string", description: "e.g. \"0 9 * * 1-5\" or \"@daily\"." },
        prompt: { type: "string", description: "What the job should do when it runs." },
        deliver: { type: "string", description: "Where the result goes, e.g. slack:#channel." },
        skills: { type: "array", items: { type: "string" } },
        enabled_toolsets: { type: "array", items: { type: "string" }, description: "Including terminal requires approval." },
        workdir: { type: "string" },
      },
      required: ["action"],
    },
  },
];

export interface CronAdapterOptions {
  profileDir: string;
  /** Injectable filesystem for tests that simulate a failing write. */
  io?: Partial<ConfigIO>;
  now?: () => Date;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function hasTerminal(args: Record<string, unknown>): boolean {
  return (asStringArray(args.enabled_toolsets) ?? []).some((t) => t.toLowerCase() === "terminal");
}

function describe(job: CronJob): string {
  const extras = [
    job.deliver ? `deliver=${job.deliver}` : "",
    job.skills?.length ? `skills=${job.skills.join(",")}` : "",
    job.enabled_toolsets?.length ? `toolsets=${job.enabled_toolsets.join(",")}` : "",
    job.workdir ? `workdir=${job.workdir}` : "",
  ].filter(Boolean);
  return `- ${job.id} "${job.name}" [${job.enabled ? "enabled" : "paused"}] ${job.schedule}${extras.length ? ` (${extras.join(" ")})` : ""}\n  prompt: ${job.prompt}`;
}

export function createCronAdapter(options: CronAdapterOptions): TrentToolAdapter {
  const io: ConfigIO = { ...NODE_IO, ...(options.io ?? {}) };
  const file = path.join(options.profileDir, "cron", "jobs.json");
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(CRON_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "cron"));

  function load(): CronJob[] {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { jobs?: CronJob[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  }

  function save(jobs: CronJob[]): void {
    if (!io.existsSync(path.dirname(file))) io.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(io, file, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, JOBS_FILE_MODE);
  }

  /** A finding blocks the write. The summary names the categories, never the matched text. */
  function injectionBlock(action: string, prompt: string): ToolCallRecord | null {
    const findings = scanPromptForInjection(prompt);
    if (!findings.length) return null;
    const reasons = [...new Set(findings.map((f) => `${f.category}: ${f.reason}`))];
    return record(
      action,
      "blocked",
      `cronjob_manage refused this prompt (prompt injection / credential scan): ${reasons.join("; ")}. ` +
        "Scheduled prompts run unattended, so this cannot be overridden. Rewrite the prompt without it."
    );
  }

  function create(action: string, args: Record<string, unknown>): ToolCallRecord {
    const prompt = argString(args, "prompt");
    if (!prompt) return record(action, "failed", "create requires \"prompt\".");
    const schedule = validateCronExpression(args.schedule);
    if (!schedule.ok) return record(action, "failed", `create refused: invalid schedule - ${schedule.reason}.`);
    const blocked = injectionBlock(action, prompt);
    if (blocked) return blocked;
    const stamp = now();
    const job: CronJob = {
      id: `job_${crypto.randomBytes(5).toString("hex")}`,
      name: argString(args, "name") ?? prompt.slice(0, 40),
      schedule: schedule.normalized,
      prompt,
      deliver: argString(args, "deliver"),
      skills: asStringArray(args.skills),
      enabled_toolsets: asStringArray(args.enabled_toolsets),
      workdir: argString(args, "workdir"),
      enabled: true,
      created_at: stamp,
      updated_at: stamp,
    };
    save([...load(), job]);
    return record(action, "completed", `Created job id ${job.id} "${job.name}" on ${job.schedule}. ${RUNNER_NOTE}`);
  }

  function update(action: string, args: Record<string, unknown>, job: CronJob, jobs: CronJob[]): ToolCallRecord {
    const next: CronJob = { ...job };
    if (args.schedule !== undefined) {
      const schedule = validateCronExpression(args.schedule);
      if (!schedule.ok) return record(action, "failed", `update refused: invalid schedule - ${schedule.reason}.`);
      next.schedule = schedule.normalized;
    }
    if (args.prompt !== undefined) {
      const prompt = argString(args, "prompt");
      if (!prompt) return record(action, "failed", "update: \"prompt\" may not be empty.");
      const blocked = injectionBlock(action, prompt);
      if (blocked) return blocked;
      next.prompt = prompt;
    }
    for (const key of ["name", "deliver", "workdir"] as const) {
      const v = argString(args, key);
      if (v !== undefined) next[key] = v;
    }
    for (const key of ["skills", "enabled_toolsets"] as const) {
      const v = asStringArray(args[key]);
      if (v !== undefined) next[key] = v;
    }
    next.updated_at = now();
    save(jobs.map((j) => (j.id === job.id ? next : j)));
    return record(action, "completed", `Updated job ${job.id} (${EDITABLE.filter((k) => args[k] !== undefined).join(", ")}). ${RUNNER_NOTE}`);
  }

  function mutate(action: string, act: CronAction, args: Record<string, unknown>): ToolCallRecord {
    const jobId = argString(args, "job_id");
    if (!jobId) return record(action, "failed", `${act} requires "job_id".`);
    const jobs = load();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return record(action, "failed", `No job with id ${jobId}. Use action "list".`);
    switch (act) {
      case "update":
        return update(action, args, job, jobs);
      case "pause":
      case "resume": {
        const enabled = act === "resume";
        save(jobs.map((j) => (j.id === job.id ? { ...j, enabled, updated_at: now() } : j)));
        return record(action, "completed", `Job ${job.id} is now ${enabled ? "enabled" : "paused"}. ${RUNNER_NOTE}`);
      }
      case "remove":
        save(jobs.filter((j) => j.id !== job.id));
        return record(action, "completed", `Removed job ${job.id} "${job.name}".`);
      case "run": {
        const blocked = injectionBlock(action, job.prompt);
        if (blocked) return blocked;
        save(jobs.map((j) => (j.id === job.id ? { ...j, run_requested_at: now() } : j)));
        return record(action, "completed", `Recorded a run request for job ${job.id}. ${RUNNER_NOTE}`);
      }
      default:
        return record(action, "failed", `Unsupported action "${act}".`);
    }
  }

  return {
    name: CRON_ADAPTER_NAME,
    scopes: [CRON_ADAPTER_NAME, "cronjob_manage", "cron:write"],
    availability: "real",
    instructions: renderToolInstructions(CRON_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, args } = parseAction(action, SPECS);
      return tool === "cronjob_manage" && (args.action === "create" || args.action === "update") && hasTerminal(args);
    },
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const act = args.action;
      if (!ACTIONS.includes(act as CronAction)) {
        return record(action, "failed", `cronjob_manage "action" must be one of ${ACTIONS.join(", ")}.`);
      }
      try {
        if (act === "create") return create(action, args);
        if (act === "list") {
          const jobs = load();
          const body = jobs.length ? jobs.map(describe).join("\n") : "No scheduled jobs.";
          return record(action, "completed", `${jobs.length} job(s) in ${file}:\n${body}\n${RUNNER_NOTE}`);
        }
        return mutate(action, act as CronAction, args);
      } catch (err) {
        return record(action, "failed", `cronjob_manage ${String(act)} failed; jobs.json is unchanged: ${(err as Error).message}`);
      }
    },
    async dryRun(action) {
      return record(action, "mocked", `cron dry-run: would apply "${action}" to ${file}. ${RUNNER_NOTE}`);
    },
    async cleanup() {},
  };
}
