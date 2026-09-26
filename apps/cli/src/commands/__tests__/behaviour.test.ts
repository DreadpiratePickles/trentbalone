/**
 * The three failures being fixed, asserted directly:
 *   1. `--json` is universal (registry.test.ts).
 *   2. `trent doctor` exits non-zero when a check fails, and speaks JSON.
 *   3. Commands read real state instead of printing canned text.
 * Plus the exit-code contract, the error envelope, first-run setup, and the `serve` shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { DoctorCheck, DoctorReport } from "@trent/core/doctor/index.js";
import { PROVIDER_ENV_VARS } from "@trent/core/setup/index.js";
import type { SetupSummary } from "../context.js";
import { runCli } from "../index.js";

const LIVE_KEY = "sk-live-abcdefghijklmnopqrstuvwxyz012345";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-behaviour-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function passingCheck(id: string): DoctorCheck {
  return {
    id,
    name: id,
    category: "test",
    run: async () => ({ category: "test", name: id, status: "ok", message: "fine" }),
  };
}

function failingCheck(id: string): DoctorCheck {
  return {
    id,
    name: id,
    category: "test",
    run: async () => ({
      category: "test",
      name: id,
      status: "fail",
      message: "deliberately broken",
      fixHint: "fix it",
    }),
  };
}

describe("exit codes", () => {
  const cases: [string, number][] = [
    ["usage", EXIT.USAGE],
    ["config", EXIT.CONFIG],
    ["auth", EXIT.AUTH],
    ["provider", EXIT.PROVIDER],
    ["budget", EXIT.BUDGET],
    ["interrupt", EXIT.INTERRUPT],
  ];

  for (const [klass, code] of cases) {
    it(`maps a ${klass} failure to exit ${code}`, async () => {
      const result = await runCli(["doctor", "--json"], {
        overrides: {
          doctorRunAll: async () => {
            throw new TrentError({
              code: code as 2 | 3 | 4 | 5 | 6 | 130,
              operation: `test.${klass}`,
              message: `${klass} failure`,
            });
          },
        },
      });
      expect(result.exitCode).toBe(code);
      const parsed = JSON.parse(result.stdout) as { error: { code: number; operation: string } };
      expect(parsed.error.code).toBe(code);
      expect(parsed.error.operation).toBe(`test.${klass}`);
    });
  }

  it("maps an unknown command to exit 2", async () => {
    const result = await runCli(["definitely-not-a-command", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(JSON.parse(result.stdout)).toHaveProperty("error.code", EXIT.USAGE);
  });

  it("maps an unknown option to exit 2", async () => {
    const result = await runCli(["doctor", "--not-a-flag", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(JSON.parse(result.stdout)).toHaveProperty("error.code", EXIT.USAGE);
  });

  it("exits 0 on a successful command", async () => {
    const result = await runCli(["tools", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
  });
});

describe("error envelope", () => {
  it("emits the TrentError envelope and never leaks a secret", async () => {
    const result = await runCli(["doctor", "--json"], {
      overrides: {
        doctorRunAll: async () => {
          throw new TrentError({
            code: EXIT.AUTH,
            operation: "doctor.credentials",
            message: `provider rejected ${LIVE_KEY}`,
            context: { apiKey: LIVE_KEY, note: `bearer ${LIVE_KEY}` },
          });
        },
      },
    });

    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(result.stdout).not.toContain(LIVE_KEY);
    expect(result.stderr).not.toContain(LIVE_KEY);

    const parsed = JSON.parse(result.stdout) as {
      error: { code: number; operation: string; message: string; context: Record<string, string> };
    };
    expect(parsed.error.code).toBe(EXIT.AUTH);
    expect(parsed.error.operation).toBe("doctor.credentials");
    expect(parsed.error.context.apiKey).toBe("[redacted]");
    expect(parsed.error.context.note).toBe("[redacted]");
  });

  it("redacts a secret in human mode too", async () => {
    const result = await runCli(["doctor"], {
      overrides: {
        doctorRunAll: async () => {
          throw new TrentError({
            code: EXIT.PROVIDER,
            operation: "doctor.probe",
            message: `upstream refused ${LIVE_KEY}`,
          });
        },
      },
    });
    expect(result.exitCode).toBe(EXIT.PROVIDER);
    expect(`${result.stdout}${result.stderr}`).not.toContain(LIVE_KEY);
    expect(result.stderr).toContain("error:");
  });
});

describe("trent doctor", () => {
  it("exits non-zero when any check fails — Hermes exits 0 here", async () => {
    const result = await runCli(["doctor", "--json"], {
      overrides: { doctorChecks: [passingCheck("a"), failingCheck("b")] },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const report = JSON.parse(result.stdout) as DoctorReport & { exitCode: number };
    expect(report.errors).toBe(1);
    expect(report.exitCode).toBe(EXIT.CONFIG);
  });

  it("exits 0 when every check passes", async () => {
    const result = await runCli(["doctor", "--json"], {
      overrides: { doctorChecks: [passingCheck("a"), passingCheck("b")] },
    });
    expect(result.exitCode).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.passed).toBe(2);
  });

  it("exits non-zero in human mode too", async () => {
    const result = await runCli(["doctor"], {
      overrides: { doctorChecks: [failingCheck("b")] },
    });
    expect(result.exitCode).toBe(EXIT.CONFIG);
  });

  it("works with no config at all", async () => {
    const result = await runCli(["doctor", "--json"], {
      overrides: { doctorChecks: [passingCheck("a")] },
    });
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
    expect(result.exitCode).toBe(EXIT.OK);
  });
});

describe("first run", () => {
  it("launches the setup wizard when no config exists", async () => {
    let launched = false;
    const result = await runCli([], {
      overrides: {
        runSetup: async () => {
          launched = true;
          return { mode: "quick", success: true, message: "done", secretsConfigured: [] };
        },
        startRepl: async () => {
          throw new Error("REPL must not start before setup");
        },
      },
    });
    expect(launched).toBe(true);
    expect(result.exitCode).toBe(EXIT.OK);
  });

  it("does not launch setup for `doctor`", async () => {
    let launched = false;
    const result = await runCli(["doctor", "--json"], {
      overrides: {
        doctorChecks: [passingCheck("a")],
        runSetup: async () => {
          launched = true;
          return { mode: "quick", success: true, message: "", secretsConfigured: [] };
        },
      },
    });
    expect(launched).toBe(false);
    expect(result.exitCode).toBe(EXIT.OK);
  });

  it("`--version` works with no config", async () => {
    const result = await runCli(["--version"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
  });

  it("`--version --json` works with no config", async () => {
    const result = await runCli(["--version", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toHaveProperty("version");
  });
});

const NO_KEY: SetupSummary = { mode: "quick", success: false, reason: "no-key", message: "No provider key found.", secretsConfigured: [] };
const CANCELLED: SetupSummary = { mode: "quick", success: false, reason: "cancelled", message: "Setup cancelled.", secretsConfigured: [] };
const DONE: SetupSummary = { mode: "quick", success: true, message: "Quick setup complete.", secretsConfigured: [] };

describe("first run without a provider key", () => {
  it("says setup did not complete and opens the REPL in degraded mode", async () => {
    let opened = false;
    const result = await runCli([], {
      overrides: { runSetup: async () => NO_KEY, startRepl: async () => void (opened = true) },
    });
    expect(opened).toBe(true);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("Setup did not complete: No provider key found.");
    expect(result.stdout).not.toContain("Setup complete");
  });

  it("hands the REPL to the binary entry point when no harness drives it", async () => {
    const result = await runCli([], { overrides: { runSetup: async () => NO_KEY } });
    expect(result.launch).toBe("repl");
    expect(result.exitCode).toBe(EXIT.OK);
  });

  it("stopping for any other reason exits 3 and opens nothing", async () => {
    const result = await runCli([], {
      overrides: { runSetup: async () => CANCELLED, startRepl: async () => { throw new Error("no REPL after a cancelled setup"); } },
    });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.launch).toBeUndefined();
    expect(result.stdout).toContain("Setup did not complete: Setup cancelled.");
  });

  it("under --json prints one JSON document, exits 3 and opens nothing", async () => {
    const result = await runCli(["--json"], { overrides: { runSetup: async () => NO_KEY } });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.launch).toBeUndefined();
    expect((JSON.parse(result.stdout) as { setup: SetupSummary }).setup.reason).toBe("no-key");
  });
});

describe("trent setup", () => {
  it("exits 3 and prints `Setup did not complete: <reason>` when it did not complete", async () => {
    const result = await runCli(["setup"], { overrides: { runSetup: async () => NO_KEY } });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("Setup did not complete: No provider key found.");
  });

  it("--json prints exactly one JSON document in every outcome", async () => {
    const cases: [string, string[], SetupSummary | undefined, number][] = [
      ["complete", ["setup", "--json"], DONE, EXIT.OK],
      ["no key", ["setup", "--json"], NO_KEY, EXIT.CONFIG],
      ["cancelled", ["setup", "--json"], CANCELLED, EXIT.CONFIG],
      ["dry run", ["setup", "--json", "--dry-run"], DONE, EXIT.OK],
      ["bad mode", ["setup", "--json", "--mode", "nope"], DONE, EXIT.USAGE],
    ];
    for (const [name, argv, summary, code] of cases) {
      const result = await runCli(argv, { overrides: { runSetup: async () => summary as SetupSummary } });
      expect(result.exitCode, name).toBe(code);
      expect(() => JSON.parse(result.stdout), name).not.toThrow();
    }
  });

  describe("the real wizard on a profile with no provider key", () => {
    beforeEach(() => {
      for (const name of Object.values(PROVIDER_ENV_VARS).flat()) vi.stubEnv(name, "");
      // [C9] And no local runtime: with one, the text leads with `trent setup --mode local` (setup-keyless.test.ts).
      vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:9/v1");
      vi.stubEnv("LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
    });
    afterEach(() => vi.unstubAllEnvs());

    /** Run with the binary's tee, capturing what reaches the real stdout and stderr. */
    async function teed(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const out: string[] = [];
      const err: string[] = [];
      const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      try {
        const result = await runCli(argv, { tee: true });
        return { exitCode: result.exitCode, stdout: out.join(""), stderr: err.join("") };
      } finally {
        o.mockRestore();
        e.mockRestore();
      }
    }

    it("text: exit 3, the guidance, and the reason exactly once", async () => {
      const result = await teed(["setup"]);
      expect(result.exitCode).toBe(EXIT.CONFIG);
      expect(result.stdout).toContain("GEMINI_API_KEY");
      expect(result.stdout).toContain("Setup did not complete: No provider key found.");
      expect(result.stdout.match(/No provider key found\./g)).toHaveLength(1);
    });

    it("--json: stdout is one JSON document; the guidance goes to stderr", async () => {
      const result = await teed(["setup", "--json"]);
      expect(result.exitCode).toBe(EXIT.CONFIG);
      const doc = JSON.parse(result.stdout) as SetupSummary;
      expect(doc.success).toBe(false);
      expect(doc.reason).toBe("no-key");
      expect(result.stderr).toContain("GEMINI_API_KEY");
    });

    it("blank-slate with no terminal: one readable error line, exit 2, no config written", async () => {
      const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        const result = await teed(["setup", "--mode", "blank-slate"]);
        expect(result.exitCode).toBe(EXIT.USAGE);
        expect(result.stderr.split("\n")[0]).toMatch(/^error: setup\.blank-slate: stdin is not a terminal/);
        expect(result.stderr).not.toContain("force closed");
        expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
      } finally {
        if (saved === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
        else Object.defineProperty(process.stdin, "isTTY", saved);
      }
    }, 15_000);
  });
});

describe("serve deprecation shim", () => {
  it("points at the new name and exits 2", async () => {
    const result = await runCli(["serve"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(`${result.stdout}${result.stderr}`).toContain("trent a2a serve");
    expect(`${result.stdout}${result.stderr}`).toContain("trent web");
  });

  it("emits the envelope in JSON mode", async () => {
    const result = await runCli(["serve", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    const parsed = JSON.parse(result.stdout) as { error: { message: string } };
    expect(parsed.error.message).toContain("trent a2a serve");
  });
});

describe("real state, not canned text", () => {
  it("`tools` reflects a toolset written to config", async () => {
    const enabled = await runCli(["tools", "--enable", "browser", "--json"]);
    expect(enabled.exitCode).toBe(EXIT.OK);
    const result = await runCli(["tools", "--json"]);
    const parsed = JSON.parse(result.stdout) as { enabled: string[]; disabled: string[] };
    expect(parsed.enabled).toContain("browser");

    const off = await runCli(["tools", "--disable", "browser", "--json"]);
    expect(off.exitCode).toBe(EXIT.OK);
    const after = JSON.parse((await runCli(["tools", "--json"])).stdout) as {
      enabled: string[];
      disabled: string[];
    };
    expect(after.enabled).not.toContain("browser");
    expect(after.disabled).toContain("browser");
  });

  it("`config get` reads back what `config set` wrote", async () => {
    const set = await runCli(["config", "set", "model", "gpt-test-9", "--json"]);
    expect(set.exitCode).toBe(EXIT.OK);
    const got = await runCli(["config", "get", "model", "--json"]);
    const parsed = JSON.parse(got.stdout) as { key: string; value: unknown };
    expect(parsed.value).toBe("gpt-test-9");
  });

  it("`config unset` removes the value", async () => {
    await runCli(["config", "set", "personality", "brisk", "--json"]);
    await runCli(["config", "unset", "personality", "--json"]);
    const got = await runCli(["config", "get", "personality", "--json"]);
    const parsed = JSON.parse(got.stdout) as { value: unknown };
    expect(parsed.value === undefined || parsed.value === null || parsed.value === "default").toBe(
      true,
    );
  });

  it("`config get` never prints a secret value", async () => {
    await runCli(["config", "set", "OPENAI_API_KEY", LIVE_KEY, "--json"]);
    const got = await runCli(["config", "get", "OPENAI_API_KEY", "--json"]);
    expect(got.stdout).not.toContain(LIVE_KEY);
    const parsed = JSON.parse(got.stdout) as { value: unknown; secret: boolean };
    expect(parsed.secret).toBe(true);
  });

  it("`sessions list` reports the real session count", async () => {
    const result = await runCli(["sessions", "list", "--json"]);
    const parsed = JSON.parse(result.stdout) as { count: number; sessions: unknown[] };
    expect(parsed.count).toBe(parsed.sessions.length);
  });

  it("`mcp list` reports the real connector gallery, not four hard-coded rows", async () => {
    const result = await runCli(["mcp", "list", "--json"]);
    const parsed = JSON.parse(result.stdout) as { available: { id: string }[] };
    expect(parsed.available.length).toBeGreaterThan(4);
  });
});

describe("human mode", () => {
  it("renders without ANSI when --no-color is passed", async () => {
    const result = await runCli(["tools", "--no-color"]);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\[/);
    expect(result.exitCode).toBe(EXIT.OK);
  });

  it("contains no emoji", async () => {
    const result = await runCli(["tools", "--no-color"]);
    expect(result.stdout).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
