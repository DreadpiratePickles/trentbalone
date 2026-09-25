/**
 * The two unit files `trent service install` writes: a launchd user agent on macOS and a systemd
 * user unit on Linux. Rendering is pure, so these tests need no service manager. On macOS the
 * plist is also handed to `plutil -lint` and converted to JSON by `plutil`, which is Apple's own
 * parser: a plist that validates here is one launchd can read. The systemd unit is checked by a
 * structural parse (sections, keys, quoting), because `systemd-analyze` does not exist off Linux.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import {
  assertServiceProfileName,
  daemonArguments,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceEnvironment,
  serviceLabel,
  servicePathValue,
  systemdUnitName,
  type ServiceUnitSpec,
} from "./units.js";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-service-units-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function spec(overrides: Partial<ServiceUnitSpec> = {}): ServiceUnitSpec {
  return {
    profile: "default",
    programArguments: daemonArguments(["/usr/local/bin/node", "/opt/trent/dist/index.js"], "default"),
    workingDirectory: "/Users/founder/work",
    environment: serviceEnvironment({ trentHome: "/Users/founder/.trent", profile: "default", path: "/usr/local/bin:/usr/bin:/bin" }),
    stdoutPath: "/Users/founder/.trent/logs/service.stdout.log",
    stderrPath: "/Users/founder/.trent/logs/service.stderr.log",
    ...overrides,
  };
}

/** `[Section]` -> key -> every value it was given, in order. Comments and blank lines are dropped. */
function parseUnit(text: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header !== null) {
      current = new Map();
      sections.set(header[1]!, current);
      continue;
    }
    const entry = /^([A-Za-z]+)=(.*)$/.exec(line);
    expect(entry, `not a key=value line: ${line}`).not.toBeNull();
    expect(current, `key outside a section: ${line}`).toBeDefined();
    const values = current!.get(entry![1]!) ?? [];
    values.push(entry![2]!);
    current!.set(entry![1]!, values);
  }
  return sections;
}

/** systemd's own word splitting for a double-quoted command line: `"a b" "c\"d"`. */
function splitQuoted(value: string): string[] {
  const words: string[] = [];
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"/g)) words.push(match[1]!.replace(/\\(.)/g, "$1"));
  return words;
}

describe("names", () => {
  it("labels the agent uk.let-trent.<profile> and the unit trent-<profile>.service", () => {
    expect(serviceLabel("default")).toBe("uk.let-trent.default");
    expect(serviceLabel("work")).toBe("uk.let-trent.work");
    expect(systemdUnitName("work")).toBe("trent-work.service");
  });

  it("refuses a profile name that cannot be a file name or a label", () => {
    for (const bad of ["", "../etc", "a b", "work/x", "-x", "a\nb", "x".repeat(65)]) {
      let caught: unknown;
      try {
        assertServiceProfileName(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(bad)).toBeInstanceOf(TrentError);
      expect((caught as TrentError).code).toBe(EXIT.CONFIG);
    }
    for (const good of ["default", "work", "client.a-1", "A_b"]) expect(() => assertServiceProfileName(good)).not.toThrow();
  });

  it("the daemon argv is the program, then service daemon --profile <p> --no-color (its output lands in a file)", () => {
    expect(daemonArguments(["/opt/trent"], "work")).toEqual(["/opt/trent", "service", "daemon", "--profile", "work", "--no-color"]);
  });

  it("the environment carries TRENT_HOME, TRENT_PROFILE, PATH and the standalone queue switch, and nothing else", () => {
    const env = serviceEnvironment({ trentHome: "/h/.trent", profile: "work", path: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin", TRENT_HOME: "/h/.trent", TRENT_PROFILE: "work", TRENT_QUEUE_FALLBACK: "disabled" });
  });
});

describe("servicePathValue", () => {
  it("keeps absolute entries once each, in order: launchd and systemd expand neither ~ nor a relative entry", () => {
    expect(servicePathValue("/repo/node_modules/.bin:/usr/bin:/repo/node_modules/.bin:~/.dotnet/tools:relative::/bin:/Applications/VMware Fusion.app/Contents/Public")).toBe(
      "/repo/node_modules/.bin:/usr/bin:/bin:/Applications/VMware Fusion.app/Contents/Public",
    );
  });

  it("falls back to the system directories when nothing absolute is left", () => {
    expect(servicePathValue("")).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(servicePathValue("~/bin")).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("renderLaunchdPlist", () => {
  it("renders a user agent: label, argv, KeepAlive, RunAtLoad, logs under the profile, the environment", () => {
    const text = renderLaunchdPlist(spec());
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"')).toBe(true);
    expect(text).toContain("<key>Label</key>\n  <string>uk.let-trent.default</string>");
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(text).toContain("<string>/Users/founder/.trent/logs/service.stdout.log</string>");
    expect(text).toContain("<string>/Users/founder/.trent/logs/service.stderr.log</string>");
    expect(text).toContain("<key>TRENT_QUEUE_FALLBACK</key>\n    <string>disabled</string>");
    expect(text.endsWith("</plist>\n")).toBe(true);
  });

  it("escapes XML in every string it writes", () => {
    const text = renderLaunchdPlist(spec({ workingDirectory: "/Users/a&b/<odd> \"dir\"" }));
    expect(text).toContain("<string>/Users/a&amp;b/&lt;odd&gt; &quot;dir&quot;</string>");
  });

  it.runIf(process.platform === "darwin")("validates with plutil -lint and parses back to the same structure", () => {
    const file = path.join(scratch, "uk.let-trent.default.plist");
    fs.writeFileSync(file, renderLaunchdPlist(spec({ workingDirectory: "/tmp/a&b dir" })));
    const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(lint.stdout).toContain("OK");
    expect(lint.status).toBe(0);
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      Label: "uk.let-trent.default",
      ProgramArguments: ["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "daemon", "--profile", "default", "--no-color"],
      WorkingDirectory: "/tmp/a&b dir",
      EnvironmentVariables: { PATH: "/usr/local/bin:/usr/bin:/bin", TRENT_HOME: "/Users/founder/.trent", TRENT_PROFILE: "default", TRENT_QUEUE_FALLBACK: "disabled" },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ProcessType: "Background",
      StandardOutPath: "/Users/founder/.trent/logs/service.stdout.log",
      StandardErrorPath: "/Users/founder/.trent/logs/service.stderr.log",
    });
  });
});

describe("renderSystemdUnit", () => {
  it("has the keys a user unit needs: ExecStart, Restart=always, WantedBy=default.target", () => {
    const unit = parseUnit(renderSystemdUnit(spec({ profile: "work", programArguments: daemonArguments(["/usr/bin/node", "/opt/trent/dist/index.js"], "work") })));
    expect([...unit.keys()]).toEqual(["Unit", "Service", "Install"]);
    expect(unit.get("Unit")?.get("Description")?.[0]).toContain("profile work");
    const service = unit.get("Service")!;
    expect(service.get("Type")).toEqual(["simple"]);
    expect(splitQuoted(service.get("ExecStart")![0]!)).toEqual(["/usr/bin/node", "/opt/trent/dist/index.js", "service", "daemon", "--profile", "work", "--no-color"]);
    expect(service.get("Restart")).toEqual(["always"]);
    expect(service.get("WorkingDirectory")).toEqual(["/Users/founder/work"]);
    // The daemon exits 130 after a signal-driven release; that is a clean stop, not a failure.
    expect(service.get("SuccessExitStatus")).toEqual(["130"]);
    const env = (service.get("Environment") ?? []).flatMap(splitQuoted);
    expect(env).toEqual(["PATH=/usr/local/bin:/usr/bin:/bin", "TRENT_HOME=/Users/founder/.trent", "TRENT_PROFILE=default", "TRENT_QUEUE_FALLBACK=disabled"]);
    expect(unit.get("Install")?.get("WantedBy")).toEqual(["default.target"]);
  });

  it("quotes and escapes: a space stays in one word, a quote and a backslash are escaped, % and $ are doubled", () => {
    const text = renderSystemdUnit(spec({ programArguments: ["/opt/my trent/bin", "say \"hi\"\\", "100%", "$HOME"], workingDirectory: "/w/50%" }));
    const service = parseUnit(text).get("Service")!;
    const exec = service.get("ExecStart")![0]!;
    expect(exec).toBe('"/opt/my trent/bin" "say \\"hi\\"\\\\" "100%%" "$$HOME"');
    expect(service.get("WorkingDirectory")).toEqual(["/w/50%%"]);
  });

  it("refuses a newline anywhere in a value, which would end the line and start a new key", () => {
    expect(() => renderSystemdUnit(spec({ workingDirectory: "/w\nExecStartPre=/bin/evil" }))).toThrow(TrentError);
    expect(() => renderLaunchdPlist(spec({ programArguments: ["/a\u0000b"] }))).toThrow(TrentError);
  });
});
