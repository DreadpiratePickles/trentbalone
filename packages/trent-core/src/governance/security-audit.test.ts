/**
 * E2: `trent security audit` — the report a user runs before trusting a profile.
 *
 * The two cases that matter are the two a user actually has: a profile that is fine, which must
 * say so and exit clean, and a profile that has been weakened, which must name every weakening.
 * Both run against a real temporary profile directory: every section reads config, files and
 * stores, so a test that stubbed them would prove nothing about the command a user runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TrentConfigSchema } from "../config/schema.js";
import { HARDLINE_RULES } from "./hardline.js";
import {
  SECURITY_SECTION_IDS,
  auditProfileSecurity,
  type SecurityAuditReport,
  type SecuritySectionId,
} from "./security-audit.js";

let profileDir: string;
let workspace: string;

const CLEAN_CONFIG = ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", ""].join("\n");

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(profileDir, "config.yaml"), body, { mode: 0o644 });
}

async function audit(): Promise<SecurityAuditReport> {
  const configPath = path.join(profileDir, "config.yaml");
  const config = TrentConfigSchema.parse(parseYaml(fs.readFileSync(configPath, "utf8")));
  return await auditProfileSecurity({
    profile: "default",
    profileDir,
    configPath,
    secretsPath: path.join(profileDir, ".env"),
    config,
    cwd: workspace,
    home: profileDir,
  });
}

const section = (report: SecurityAuditReport, id: SecuritySectionId): Record<string, unknown> => {
  const found = report.sections.find((s) => s.id === id);
  expect(found, `no section ${id}`).toBeDefined();
  return found!.details;
};

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-secaudit-")));
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-secaudit-ws-")));
  writeConfig(CLEAN_CONFIG);
  fs.writeFileSync(path.join(profileDir, ".env"), "OPENAI_API_KEY=placeholder\n", { mode: 0o600 });
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("a profile with nothing wrong with it", () => {
  it("reports every section and finds nothing", async () => {
    const report = await audit();

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sections.map((s) => s.id)).toEqual([...SECURITY_SECTION_IDS]);
  });

  it("reads the hardline list from the shipped rules, with a hash of their content", async () => {
    const report = await audit();
    const details = section(report, "approvals");

    expect(details.hardlineCount).toBe(HARDLINE_RULES.length);
    expect(String(details.hardlineHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(details.denyGlobs).toEqual([]);
  });

  it("proves the configured autonomy level lifts no floor instead of asserting it", async () => {
    const report = await audit();
    const details = section(report, "autonomy");

    expect(details.level).toBe("ask_dangerous");
    expect(details.liftsAnyFloor).toBe(false);
    expect(details.floorsStillRefusing).toEqual(["hardline", "approvals.deny", "approval-floor"]);
    // [U1] The class floor is probed the same way: the verdict function is asked, at the configured level.
    expect(details.classFloorStillAsks).toBe(true);
    expect(details.classFloor).toEqual(["external_send", "money_moving", "customer_facing"]);
  });

  it("names the egress interception set and the sandbox backend from the real config", async () => {
    const report = await audit();
    const details = section(report, "egress");

    expect(details.enabled).toBe(true);
    expect(details.interceptDomains).toContain("api.anthropic.com");
    expect(details.sandboxBackend).toBe("docker");
  });

  it("reports the untrusted working directory without calling it a finding", async () => {
    const report = await audit();
    const details = section(report, "workspace");

    expect(details.trusted).toBe(false);
    expect(report.findings).toEqual([]);
  });
});

describe("a profile that has been weakened", () => {
  beforeEach(() => {
    writeConfig(
      [
        CLEAN_CONFIG,
        "autonomy: never",
        "hooks:",
        "  pre_tool_call:",
        "    - command: [/bin/echo, gate]",
        "openai_api_key: sk-notarealkeyjustashapethatmatches",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(profileDir, ".env"), 0o644);
  });

  it("names the unconsented hook, the readable .env, the autonomy level and the secret in config.yaml", async () => {
    const report = await audit();

    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.id).sort()).toEqual([
      "autonomy-never",
      "hook-not-consented",
      "profile-file-too-permissive",
      "secret-in-config-yaml",
    ]);
  });

  it("gives every finding a severity and a fix line", async () => {
    const report = await audit();

    for (const finding of report.findings) {
      expect(["critical", "high", "medium", "low"]).toContain(finding.severity);
      expect(finding.fix.length, `${finding.id} has no fix`).toBeGreaterThan(0);
      expect(SECURITY_SECTION_IDS).toContain(finding.section);
    }
  });

  it("names the config key that holds a secret and never the secret itself", async () => {
    const report = await audit();
    const finding = report.findings.find((f) => f.id === "secret-in-config-yaml");

    expect(finding?.severity).toBe("critical");
    expect(finding?.message).toContain("openai_api_key");
    expect(JSON.stringify(report)).not.toContain("sk-notarealkeyjustashapethatmatches");
  });

  it("names the file whose mode is wrong and the mode it should have", async () => {
    const report = await audit();
    const finding = report.findings.find((f) => f.id === "profile-file-too-permissive");

    expect(finding?.message).toContain(".env");
    expect(finding?.message).toContain("644");
    expect(section(report, "file-permissions").checked).toBeGreaterThan(0);
  });

  it("stops calling the hook a finding once its exact spec is consented to", async () => {
    const consented = await audit();
    expect(consented.findings.some((f) => f.id === "hook-not-consented")).toBe(true);

    const { hookSpecHash } = await import("../hooks/consent.js");
    const hash = hookSpecHash("pre_tool_call", { command: ["/bin/echo", "gate"] });
    fs.writeFileSync(path.join(profileDir, "hooks-consent.json"), `${JSON.stringify({ version: 1, consented: [hash] })}\n`, {
      mode: 0o600,
    });

    const after = await audit();
    expect(after.findings.some((f) => f.id === "hook-not-consented")).toBe(false);
  });
});

describe("the sections that read stores rather than config", () => {
  it("refuses a plugin manifest that any process can read, and says why", async () => {
    const dir = path.join(profileDir, "plugins", "leaky");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: "leaky", version: "1.0.0", tools: [] }),
      { mode: 0o644 },
    );

    const report = await audit();
    const finding = report.findings.find((f) => f.id === "plugin-manifest-refused");

    expect(finding?.message).toContain("leaky");
    expect(section(report, "plugins").refused).toBe(1);
  });

  it("fails the audit chain section when a signed export does not verify", async () => {
    const file = path.join(profileDir, "chain.ndjson");
    fs.writeFileSync(file, `${JSON.stringify({ id: "a" })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${file}.sig`, "{}\n", { mode: 0o600 });

    const configPath = path.join(profileDir, "config.yaml");
    const report = await auditProfileSecurity({
      profile: "default",
      profileDir,
      configPath,
      secretsPath: path.join(profileDir, ".env"),
      config: TrentConfigSchema.parse(parseYaml(fs.readFileSync(configPath, "utf8"))),
      cwd: workspace,
      home: profileDir,
      auditExport: file,
    });

    expect(report.findings.map((f) => f.id)).toContain("audit-export-unverified");
    expect(section(report, "audit-chain").verified).toBe(false);
  });

  it("flags an MCP server installed over its scan findings", async () => {
    writeConfig(
      [
        CLEAN_CONFIG,
        "mcp_servers:",
        "  weather:",
        "    transport: stdio",
        "    command: /bin/echo",
        "    scanRan: true",
        "    flagged:",
        "      - tool: forecast",
        "        categories: [prompt-injection]",
        "",
      ].join("\n"),
    );

    const report = await audit();
    const finding = report.findings.find((f) => f.id === "mcp-server-flagged-tools");

    expect(finding?.message).toContain("weather");
    expect(section(report, "mcp").resultScrubbing).toBe(true);
  });
});
