/**
 * The `security` group: `trent security audit [workspace]`.
 *
 * One read-only pass over everything that decides how much a profile is allowed to do — the
 * autonomy level, the deny globs and the hardline list under them, the hooks and their consent,
 * the egress proxy and the sandbox backend, workspace trust, prompt redaction, the MCP servers,
 * the plugin manifests, the signed audit chain, the file modes under the profile and whether
 * `config.yaml` is holding a credential it should not.
 *
 * It writes nothing, so it is safe to run on a machine nobody is sitting at, and it exits 1 when
 * it has findings so a CI job can gate on it. The report never carries a secret: the config scan
 * names the KEY and the line, never the value (`@trent/core/governance/security-audit.ts`).
 */
import path from "node:path";
import process from "node:process";
import { EXIT } from "@trent/core/errors/index.js";
import {
  SECURITY_SECTION_IDS,
  auditProfileSecurity,
  type SecurityAuditReport,
  type SecurityFinding,
  type SecuritySection,
} from "@trent/core/governance/security-audit.js";
import { gradeSecurity, type SecurityGrade } from "@trent/core/governance/security-grade.js";
import { proveOffline, type OfflineProof } from "@trent/core/doctor/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** Both shapes the handler returns: the dry-run description, and the report itself. */
interface RenderData extends Omit<SecurityAuditReport, "sections"> {
  readonly dryRun?: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly sections: readonly SecuritySection[] | readonly string[];
}

/** A scalar renders as itself; anything else renders as JSON, so nothing is invented for display. */
function renderValue(value: unknown): string {
  if (value === null) return "none";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map((item) => renderValue(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function findingLines(ctx: CommandContext, findings: readonly SecurityFinding[]): string[] {
  if (findings.length === 0) return [`  ${ctx.theme.success("no findings")}`];
  const lines: string[] = [];
  for (const finding of findings) {
    const head = `${finding.severity} ${finding.id}`;
    const paint = finding.severity === "critical" || finding.severity === "high" ? ctx.theme.error : ctx.theme.needsApproval;
    lines.push(`  ${paint(head)} ${ctx.theme.body(finding.message)}`);
    lines.push(`    ${ctx.theme.meta("fix")} ${ctx.theme.value(finding.fix)}`);
  }
  return lines;
}

const auditSubSpec: CommandSpec = {
  name: "audit [workspace]",
  description: "Report everything that decides what this profile is allowed to do, and exit 1 on any finding",
  options: [
    { flags: "--audit-export <file>", description: "Re-verify this signed audit export as part of the report" },
  ],
  async run(ctx, opts, args) {
    const manager = ctx.config();
    const profileDir = manager.getProfileDir();
    const cwd = path.resolve(process.cwd(), args[0] ?? process.cwd());

    if (ctx.dryRun) {
      return {
        data: {
          dryRun: true,
          command: "security audit",
          profile: manager.getProfile(),
          profileDir,
          cwd,
          sections: [...SECURITY_SECTION_IDS],
        },
      };
    }

    const auditExport = typeof opts.auditExport === "string" && opts.auditExport.length > 0 ? path.resolve(opts.auditExport) : undefined;
    const report = await auditProfileSecurity({
      profile: manager.getProfile(),
      profileDir,
      configPath: manager.getConfigPath(),
      secretsPath: manager.getSecretsPath(),
      config: manager.loadConfig(),
      cwd,
      home: manager.getBaseDir(),
      ...(auditExport === undefined ? {} : { auditExport }),
    });

    return { data: { ...report }, exitCode: report.ok ? EXIT.OK : EXIT.RUN_FAILED };
  },
  render(data, ctx) {
    const d = data as unknown as RenderData;
    if (d.dryRun === true) {
      return [
        ctx.theme.emphasis("SECURITY AUDIT"),
        `  ${ctx.theme.meta("would audit")} ${ctx.theme.value(d.profileDir)}`,
        `  ${ctx.theme.meta("sections")}    ${ctx.theme.value((d.sections as readonly string[]).join(", "))}`,
      ];
    }

    const sections = d.sections as readonly SecuritySection[];
    const lines = [
      ctx.theme.emphasis("SECURITY AUDIT"),
      `  ${ctx.theme.body("profile")} ${ctx.theme.value(d.profile)} ${ctx.theme.meta(d.profileDir)}`,
      "",
    ];
    for (const section of sections) {
      lines.push(`  ${ctx.theme.emphasis(section.title)} ${ctx.theme.meta(`[${section.id}]`)}`);
      for (const [key, value] of Object.entries(section.details)) {
        lines.push(`    ${ctx.theme.meta(key.padEnd(20, " "))} ${ctx.theme.value(renderValue(value))}`);
      }
    }
    lines.push("");
    lines.push(`  ${ctx.theme.emphasis("FINDINGS")} ${ctx.theme.value(String(d.findings.length))}`);
    lines.push(...findingLines(ctx, d.findings));
    return lines;
  },
};

/** One backing check the grade rests on: a section and its worst finding (if any). */
interface GradeCheck {
  readonly id: string;
  readonly title: string;
  readonly worst: string | null;
  readonly findingId: string | null;
  readonly message: string | null;
  readonly fix: string | null;
}

/** What `trent security status` returns (JSON) and renders (human). */
interface GradeRenderData extends SecurityGrade {
  readonly dryRun?: boolean;
  readonly command?: string;
  readonly profile: string;
  readonly profileDir: string;
  readonly sections?: readonly string[];
  readonly checks: readonly GradeCheck[];
}

/** The findings are already sorted most-severe-first, so the first in a section is its worst. */
function backingChecks(report: SecurityAuditReport): GradeCheck[] {
  return report.sections.map((section) => {
    const worst = report.findings.find((finding) => finding.section === section.id);
    return {
      id: section.id,
      title: section.title,
      worst: worst?.severity ?? null,
      findingId: worst?.id ?? null,
      message: worst?.message ?? null,
      fix: worst?.fix ?? null,
    };
  });
}

const statusSubSpec: CommandSpec = {
  name: "status [workspace]",
  description: "Grade the profile A–F and show the exact checks behind the grade; --json carries every input",
  async run(ctx, _opts, args) {
    const manager = ctx.config();
    const profileDir = manager.getProfileDir();
    const cwd = path.resolve(process.cwd(), args[0] ?? process.cwd());

    if (ctx.dryRun) {
      return {
        data: { dryRun: true, command: "security status", profile: manager.getProfile(), profileDir, cwd, sections: [...SECURITY_SECTION_IDS] },
      };
    }

    const report = await auditProfileSecurity({
      profile: manager.getProfile(),
      profileDir,
      configPath: manager.getConfigPath(),
      secretsPath: manager.getSecretsPath(),
      config: manager.loadConfig(),
      cwd,
      home: manager.getBaseDir(),
    });
    const grade = gradeSecurity(report);
    // The card is a read/observe surface, so it does not gate: it always exits 0. `trent security
    // audit` is the command that exits 1 on findings for CI.
    return { data: { ...grade, profile: report.profile, profileDir: report.profileDir, checks: backingChecks(report) } };
  },
  render(data, ctx) {
    const d = data as unknown as GradeRenderData;
    if (d.dryRun === true) {
      return [
        ctx.theme.emphasis("SECURITY GRADE"),
        `  ${ctx.theme.meta("would grade")} ${ctx.theme.value(d.profileDir)}`,
        `  ${ctx.theme.meta("sections")}    ${ctx.theme.value((d.sections ?? []).join(", "))}`,
      ];
    }
    const paint = d.grade === "A" || d.grade === "B" ? ctx.theme.success : d.grade === "C" ? ctx.theme.needsApproval : ctx.theme.error;
    const lines = [
      ctx.theme.emphasis("SECURITY GRADE"),
      `  ${paint(d.grade)} ${ctx.theme.meta(`score ${d.score}`)} ${ctx.theme.body(`profile ${d.profile}`)}`,
      `  ${ctx.theme.meta(d.rationale)}`,
      "",
      `  ${ctx.theme.emphasis("CHECKS")} ${ctx.theme.meta("(each section and its worst finding)")}`,
    ];
    for (const check of d.checks) {
      if (check.worst === null) {
        lines.push(`  ${ctx.theme.success("ok".padEnd(9, " "))} ${ctx.theme.value(check.title)}`);
        continue;
      }
      const mark = check.worst === "critical" || check.worst === "high" ? ctx.theme.error : ctx.theme.needsApproval;
      lines.push(`  ${mark(check.worst.padEnd(9, " "))} ${ctx.theme.value(check.title)} ${ctx.theme.meta(check.message ?? "")}`);
    }
    return lines;
  },
};

/** The shape `trent security --offline` returns (JSON) and renders (human). */
interface OfflineRenderData extends OfflineProof {
  readonly kind: "offline";
}

/** The subcommand listing `trent security` (no flag) falls back to. */
interface ListingData {
  readonly kind: "listing";
  readonly command: string;
  readonly description: string;
  readonly subcommands: Array<{ name: string; description: string; usage: string }>;
}

function offlineLines(proof: OfflineProof, ctx: CommandContext): string[] {
  const lines = [ctx.theme.emphasis("OFFLINE EGRESS PROOF"), ""];
  if (!proof.offline) {
    lines.push(`  ${ctx.theme.needsApproval("offline mode is off")} — this ran the proof anyway; every row reflects the offline gate it WOULD get.`);
    lines.push("");
  }
  lines.push(
    `  ${ctx.theme.meta("canary")}  ${
      proof.canary.blocked ? ctx.theme.success(`refused ${proof.canary.target}`) : ctx.theme.error(`NOT refused ${proof.canary.target}`)
    } ${ctx.theme.meta(proof.canary.detail)}`,
  );
  lines.push(
    `  ${ctx.theme.meta("config")}  ${
      proof.config.ok ? ctx.theme.success("no hosted settings") : ctx.theme.error(proof.config.violations.join("; "))
    }`,
  );
  lines.push("");
  for (const row of proof.rows) {
    const status =
      row.status === "open"
        ? ctx.theme.error("OPEN")
        : row.status === "blocked"
          ? ctx.theme.success("blocked")
          : ctx.theme.success("loopback-only");
    lines.push(`  ${status.padEnd(14, " ")} ${ctx.theme.value(row.id.padEnd(22, " "))} ${ctx.theme.meta(row.layer)}`);
  }
  lines.push("");
  lines.push(`  ${ctx.theme.meta(proof.caveat)}`);
  const open = proof.rows.filter((r) => r.status === "open").length;
  lines.push(`  ${open === 0 ? ctx.theme.success("every egress path is covered") : ctx.theme.error(`${open} path(s) OPEN`)}`);
  return lines;
}

export const securitySpec: CommandSpec = {
  name: "security",
  description: "Read-only security reports over the active profile",
  options: [
    { flags: "--offline", description: "Prove the offline egress surface is loopback-only; exit non-zero if any path is OPEN" },
  ],
  subcommands: [statusSubSpec, auditSubSpec],
  async run(ctx, opts) {
    if (opts.offline === true) {
      const manager = ctx.config();
      let config: unknown = {};
      try {
        config = manager.loadConfig();
      } catch {
        /* a profile that will not load is the audit's finding, not this proof's; prove against {} */
      }
      // `force`: run the proof as if offline is on even when this process is not, so an operator can
      // certify coverage before flipping the switch. The canary is refused by the forced-offline dial.
      const proof = await proveOffline({ config, force: true });
      return { data: { kind: "offline", ...proof }, exitCode: proof.ok ? EXIT.OK : EXIT.RUN_FAILED };
    }
    return {
      data: {
        kind: "listing",
        command: "security",
        description: securitySpec.description,
        subcommands: (securitySpec.subcommands ?? []).map((s) => ({
          name: s.name.split(" ")[0] ?? s.name,
          description: s.description,
          usage: `security ${s.name}`,
        })),
      },
    };
  },
  render(data, ctx) {
    const d = data as unknown as OfflineRenderData | ListingData;
    if (d.kind === "offline") return offlineLines(d, ctx);
    const listing = d as ListingData;
    const lines = [ctx.theme.emphasis("SECURITY"), ctx.theme.body(listing.description), ""];
    for (const sub of listing.subcommands) lines.push(`  ${ctx.theme.value(sub.usage.padEnd(22, " "))} ${ctx.theme.meta(sub.description)}`);
    return lines;
  },
};
