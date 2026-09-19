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

export const securitySpec: CommandSpec = {
  name: "security",
  description: "Read-only security reports over the active profile",
  subcommands: [auditSubSpec],
};
