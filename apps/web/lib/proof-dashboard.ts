import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type ProofStatus = "passed" | "failed" | "partial" | "not_recorded";

export type ProofCategory = {
  key: string;
  label: string;
  status: ProofStatus;
  sourcePath?: string;
  generatedAt?: string;
  passed?: number;
  failed?: number;
  total?: number;
  detail: string;
  rerunCommand?: string;
};

export type ProofDashboard = {
  generatedAt: string;
  categories: ProofCategory[];
  summary: {
    passed: number;
    failed: number;
    partial: number;
    notRecorded: number;
  };
};

type ArtifactInput = { path: string; content: string };

const REQUIRED: Array<Omit<ProofCategory, "status" | "detail"> & { patterns: RegExp[]; missingDetail: string }> = [
  {
    key: "run_button",
    label: "Top-right Run Cycle button",
    patterns: [/run.*button.*truth.*\.json/i, /main.*run.*button.*\.json/i, /orc.*truth.*proof.*\.json/i, /orchestrator.*truth.*\.json/i],
    missingDetail: "No proof that the top-right Run Cycle button queues, reconciles, and tracks a durable run.",
    rerunCommand: "npm run orc:truth-proof",
  },
  {
    key: "orchestration",
    label: "Agent orchestration truth",
    patterns: [/orc.*truth.*proof.*\.json/i, /orchestrator.*truth.*\.json/i, /orchestration.*truth.*\.json/i, /orc.*workbench.*proof.*\.json/i],
    missingDetail: "No orchestration truth proof recorded for planning, steps, critic, approvals, evidence, and memory.",
    rerunCommand: "npm run orc:truth-proof",
  },
  {
    key: "workbench",
    label: "Workbench live build",
    patterns: [/epicA.*(soak20|diverse|interaction).*\.json/i, /workbench.*cloud.*\.json/i],
    missingDetail: "No Workbench live proof artifact recorded.",
    rerunCommand: "npm run workbench:eval:live-cloud -- --provider daytona --env-file trent.env.local --runs 1 --threshold 1",
  },
  {
    key: "operating_cycle",
    label: "Operating cycle acceptance",
    patterns: [/epicB.*acceptance.*\.json/i, /acceptance.*cycle.*\.json/i],
    missingDetail: "No operating-cycle acceptance artifact recorded.",
    rerunCommand: "npm run acceptance:cycle -- --env-file trent.env.local",
  },
  {
    key: "memory",
    label: "Compounding memory",
    patterns: [/epicC.*compounding.*\.json/i, /compounding.*proof.*\.json/i],
    missingDetail: "No memory compounding proof artifact recorded.",
    rerunCommand: "npm run compounding:proof -- --env-file trent.env.local",
  },
  {
    key: "capability",
    label: "Capability gates",
    patterns: [/capability.*gate.*\.json/i],
    missingDetail: "No capability-gate proof artifact recorded.",
    rerunCommand: "npm run capability:proof -- --env-file trent.env.local",
  },
  {
    key: "trust",
    label: "Trust / Ops UI",
    patterns: [/trust.*panel.*\.json/i, /ops.*ui.*proof.*\.json/i],
    missingDetail: "No Trust/Ops browser proof artifact recorded.",
    rerunCommand: "npm run trust-panel:proof -- --env-file trent.env.local",
  },
  {
    key: "providers",
    label: "Provider proofs",
    patterns: [/providers.*\.json/i],
    missingDetail: "No provider proof artifact recorded.",
    rerunCommand: "npm run providers:proof -- --env-file trent.env.local",
  },
  {
    key: "mcp",
    label: "MCP proof",
    patterns: [/mcp.*proof.*\.json/i],
    missingDetail: "No MCP live proof artifact recorded.",
    rerunCommand: "npm run mcp:proof -- --env-file trent.env.local",
  },
  {
    key: "production",
    label: "Production / Railway",
    patterns: [/production.*proof.*\.json/i, /railway.*proof.*\.json/i],
    missingDetail: "No production Railway proof artifact recorded.",
    rerunCommand: "Run the production browser proof after deploy.",
  },
];

export function buildProofDashboard(input: { artifacts: ArtifactInput[] }): ProofDashboard {
  const parsed = input.artifacts.map((artifact) => parseProofArtifact(artifact.path, artifact.content)).filter(Boolean) as ProofCategory[];
  const categories = REQUIRED.map((required) => {
    const match = parsed
      .filter((artifact) => required.patterns.some((pattern) => pattern.test(artifact.sourcePath ?? artifact.key)))
      .sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""))[0];
    return match
      ? { ...match, key: required.key, label: required.label, rerunCommand: required.rerunCommand }
      : {
          key: required.key,
          label: required.label,
          status: "not_recorded" as const,
          detail: required.missingDetail,
          rerunCommand: required.rerunCommand,
        };
  });

  return {
    generatedAt: new Date().toISOString(),
    categories,
    summary: {
      passed: categories.filter((category) => category.status === "passed").length,
      failed: categories.filter((category) => category.status === "failed").length,
      partial: categories.filter((category) => category.status === "partial").length,
      notRecorded: categories.filter((category) => category.status === "not_recorded").length,
    },
  };
}

export function parseProofArtifact(sourcePath: string, raw: string): ProofCategory | null {
  try {
    const data = sanitize(JSON.parse(raw)) as Record<string, unknown>;
    const summary = objectValue(data.summary);
    const passed = numberValue(data.passCount) ?? numberValue(summary?.passed);
    const failed = numberValue(data.failCount) ?? numberValue(summary?.failed);
    const total = numberValue(summary?.total) ?? totalFrom(data, passed, failed);
    const status = statusFrom(data, passed, failed, total);
    const detail = detailFrom(data, status, passed, failed, total);
    return {
      key: keyFromPath(sourcePath),
      label: keyFromPath(sourcePath),
      status,
      sourcePath,
      generatedAt: stringValue(data.generatedAt) ?? stringValue(data.completedAt) ?? stringValue(data.at),
      passed,
      failed,
      total,
      detail,
    };
  } catch {
    return {
      key: keyFromPath(sourcePath),
      label: keyFromPath(sourcePath),
      status: "failed",
      sourcePath,
      detail: "Proof artifact is not valid JSON.",
    };
  }
}

export function loadProofDashboardFromDisk(root = process.cwd()): ProofDashboard {
  const artifacts = readJsonFiles(path.join(root, "artifacts", "live-proofs"))
    .concat(readJsonFiles(path.join(root, "docs", "verification")));
  return buildProofDashboard({ artifacts });
}

function readJsonFiles(dir: string): ArtifactInput[] {
  if (!existsSync(dir)) return [];
  const out: ArtifactInput[] = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!name.endsWith(".json")) continue;
    try {
      out.push({ path: file, content: readFileSync(file, "utf8") });
    } catch {
      // Ignore unreadable proof artifacts; absence is surfaced by required categories.
    }
  }
  return out;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(secret|token|api.?key|authorization|password|credential)/i.test(key)) continue;
    out[key] = sanitize(child);
  }
  return out;
}

function statusFrom(data: Record<string, unknown>, passed?: number, failed?: number, total?: number): ProofStatus {
  if (data.passed === true) return "passed";
  if (data.passed === false) return failed && failed > 0 ? "failed" : "partial";
  if (failed && failed > 0) return passed && passed > 0 ? "partial" : "failed";
  if (passed != null && total != null && passed >= total) return "passed";
  if (passed != null && passed > 0) return "partial";
  return "not_recorded";
}

function detailFrom(data: Record<string, unknown>, status: ProofStatus, passed?: number, failed?: number, total?: number): string {
  if (typeof data.detail === "string") return data.detail;
  if (typeof data.error === "string") return data.error;
  if (passed != null || failed != null || total != null) {
    return `${passed ?? 0}/${total ?? ((passed ?? 0) + (failed ?? 0))} passed${failed ? `; ${failed} failed` : ""}.`;
  }
  return status === "not_recorded" ? "No structured proof count recorded." : `Proof status: ${status}.`;
}

function totalFrom(data: Record<string, unknown>, passed?: number, failed?: number): number | undefined {
  if (Array.isArray(data.proofs)) return data.proofs.length;
  if (Array.isArray(data.results)) return data.results.length;
  if (passed != null || failed != null) return (passed ?? 0) + (failed ?? 0);
  return undefined;
}

function keyFromPath(sourcePath: string): string {
  return path.basename(sourcePath).replace(/\.json$/i, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
