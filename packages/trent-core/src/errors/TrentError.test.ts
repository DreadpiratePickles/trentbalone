import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT,
  TrentError,
  renderHumanError,
  renderJsonError,
  toExitCode,
} from "./TrentError.js";

/**
 * Task 1.2 — the error taxonomy behind `--json` on every command.
 *
 * The point of these tests is not that an Error class exists. It is that an error envelope which is
 * printed to stdout, piped into logs, and pasted into bug reports can never leak a credential. The
 * context bag on an error is exactly where a caller reaches for "helpful debugging detail", which is
 * exactly where an API key ends up.
 */

// A realistic *shape* with no real entropy. Never put a live credential in a test.
const FAKE_ANTHROPIC_KEY = "sk-ant-api03-FAKEFAKEFAKE";
const FAKE_GITHUB_TOKEN = "ghp_FAKEFAKEFAKEFAKE";
const FAKE_GOOGLE_KEY = "AIzaFAKEFAKEFAKEFAKE";

const REDACTED = "[redacted]";

afterEach(() => {
  delete process.env.TRENT_DEBUG;
});

describe("TrentError construction", () => {
  it("carries the exit code, operation and target on the instance", () => {
    const err = new TrentError({
      code: EXIT.CONFIG,
      operation: "config load",
      message: "configuration file not found",
      target: "/home/bobby/.trent/config.yaml",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TrentError");
    expect(err.code).toBe(3);
    expect(err.operation).toBe("config load");
    expect(err.target).toBe("/home/bobby/.trent/config.yaml");
    expect(err.context).toEqual({});
  });

  it("produces an actionable message naming the operation and the offending file path", () => {
    const err = new TrentError({
      code: EXIT.CONFIG,
      operation: "config load",
      message: "configuration file not found",
      target: "/home/bobby/.trent/config.yaml",
    });

    expect(err.message).toContain("config load");
    expect(err.message).toContain("/home/bobby/.trent/config.yaml");
    expect(err.message).toContain("configuration file not found");
    expect(err.toJSON().error.message).toBe(err.message);
  });

  it("exposes the documented exit code table", () => {
    expect(EXIT).toEqual({
      OK: 0,
      USAGE: 2,
      CONFIG: 3,
      AUTH: 4,
      PROVIDER: 5,
      BUDGET: 6,
      INTERRUPT: 130,
    });
  });
});

describe("secret redaction", () => {
  it("redacts a context value whose key names a credential", () => {
    const err = new TrentError({
      code: EXIT.AUTH,
      operation: "provider auth",
      message: "the provider rejected the credential",
      target: "anthropic",
      context: { apiKey: FAKE_ANTHROPIC_KEY, model: "claude-opus-4" },
    });

    const json = err.toJSON();
    expect(json.error.context?.apiKey).toBe(REDACTED);
    expect(json.error.context?.model).toBe("claude-opus-4");
    expect(JSON.stringify(json)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(renderJsonError(err)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(renderHumanError(err)).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it("redacts every sensitive key spelling in the documented pattern", () => {
    const err = new TrentError({
      code: EXIT.AUTH,
      operation: "provider auth",
      message: "rejected",
      context: {
        API_KEY: "a",
        access_token: "b",
        clientSecret: "c",
        Password: "d",
        Authorization: "e",
        credentials: "f",
        harmless: "g",
      },
    });

    const ctx = err.toJSON().error.context ?? {};
    expect(ctx.API_KEY).toBe(REDACTED);
    expect(ctx.access_token).toBe(REDACTED);
    expect(ctx.clientSecret).toBe(REDACTED);
    expect(ctx.Password).toBe(REDACTED);
    expect(ctx.Authorization).toBe(REDACTED);
    expect(ctx.credentials).toBe(REDACTED);
    expect(ctx.harmless).toBe("g");
  });

  it("redacts recursively through nested objects and arrays", () => {
    const err = new TrentError({
      code: EXIT.PROVIDER,
      operation: "gateway call",
      message: "upstream refused the request",
      context: {
        request: {
          headers: { authorization: `Bearer ${FAKE_ANTHROPIC_KEY}` },
          retries: [{ token: FAKE_GITHUB_TOKEN }, { attempt: 2 }],
        },
        servers: [["primary", { secret: FAKE_GOOGLE_KEY }]],
      },
    });

    const serialized = renderJsonError(err);
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
    expect(serialized).not.toContain(FAKE_GOOGLE_KEY);

    const parsed = JSON.parse(serialized) as {
      error: { context?: Record<string, unknown> };
    };
    const request = parsed.error.context?.request as {
      headers: { authorization: unknown };
      retries: Array<Record<string, unknown>>;
    };
    expect(request.headers.authorization).toBe(REDACTED);
    expect(request.retries[0]?.token).toBe(REDACTED);
    expect(request.retries[1]?.attempt).toBe(2);
  });

  it("redacts a value that looks like a secret even under an innocuous key", () => {
    const err = new TrentError({
      code: EXIT.CONFIG,
      operation: "config parse",
      message: "unexpected value",
      context: {
        note: FAKE_ANTHROPIC_KEY,
        commandLine: `trent run --key ${FAKE_GITHUB_TOKEN}`,
        googleThing: FAKE_GOOGLE_KEY,
        plain: "sk-short",
      },
    });

    const ctx = err.toJSON().error.context ?? {};
    expect(ctx.note).toBe(REDACTED);
    expect(ctx.commandLine).toBe(REDACTED);
    expect(ctx.googleThing).toBe(REDACTED);
    expect(ctx.plain).toBe("sk-short");
    expect(renderJsonError(err)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it("does not blow up on circular context", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const err = new TrentError({
      code: EXIT.USAGE,
      operation: "arg parse",
      message: "bad input",
      context: cyclic,
    });

    expect(() => renderJsonError(err)).not.toThrow();
    expect(renderJsonError(err)).toContain("arg parse");
  });
});

describe("cause handling", () => {
  it("keeps cause on the instance but never serializes it", () => {
    const cause = new Error(`POST /v1/messages failed: {"api_key":"${FAKE_ANTHROPIC_KEY}"}`);
    const err = new TrentError({
      code: EXIT.PROVIDER,
      operation: "gateway call",
      message: "upstream refused the request",
      target: "anthropic",
      cause,
    });

    expect(err.cause).toBe(cause);

    const json = err.toJSON();
    expect(json.error).not.toHaveProperty("cause");
    expect(JSON.stringify(json)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(renderJsonError(err)).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(JSON.parse(renderJsonError(err))).not.toHaveProperty("error.cause");
  });
});

describe("renderJsonError", () => {
  it("emits the {error:{...}} envelope for a TrentError", () => {
    const err = new TrentError({
      code: EXIT.BUDGET,
      operation: "run start",
      message: "budget exhausted",
      target: "run_123",
    });

    const parsed = JSON.parse(renderJsonError(err)) as {
      error: { code: number; operation: string; message: string; target?: string };
    };
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(parsed.error.code).toBe(6);
    expect(parsed.error.operation).toBe("run start");
    expect(parsed.error.target).toBe("run_123");
  });

  it("emits the same envelope for a plain Error", () => {
    const parsed = JSON.parse(renderJsonError(new Error("kaboom"))) as {
      error: { code: number; operation: string; message: string };
    };
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(parsed.error.code).toBe(EXIT.USAGE);
    expect(parsed.error.message).toContain("kaboom");
    expect(typeof parsed.error.operation).toBe("string");
  });

  it("emits the same envelope for a thrown string, and redacts it", () => {
    const parsed = JSON.parse(renderJsonError(`boom ${FAKE_ANTHROPIC_KEY}`)) as {
      error: { code: number; message: string };
    };
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(parsed.error.code).toBe(EXIT.USAGE);
    expect(parsed.error.message).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(parsed.error.message).toContain(REDACTED);
  });

  it("emits the same envelope for undefined", () => {
    const parsed = JSON.parse(renderJsonError(undefined)) as { error: { code: number } };
    expect(Object.keys(parsed)).toEqual(["error"]);
    expect(parsed.error.code).toBe(EXIT.USAGE);
  });
});

describe("toExitCode", () => {
  it("maps a TrentError to its own code", () => {
    for (const code of [2, 3, 4, 5, 6, 130] as const) {
      const err = new TrentError({ code, operation: "op", message: "m" });
      expect(toExitCode(err)).toBe(code);
    }
  });

  it("maps anything else to the documented default of 2", () => {
    expect(toExitCode(new Error("kaboom"))).toBe(EXIT.USAGE);
    expect(toExitCode("kaboom")).toBe(EXIT.USAGE);
    expect(toExitCode(undefined)).toBe(EXIT.USAGE);
    expect(toExitCode(null)).toBe(EXIT.USAGE);
  });
});

describe("renderHumanError", () => {
  it("never prints a stack trace unless TRENT_DEBUG is set", () => {
    const err = new TrentError({
      code: EXIT.CONFIG,
      operation: "config load",
      message: "configuration file not found",
      target: "/home/bobby/.trent/config.yaml",
      cause: new Error("ENOENT"),
    });

    const quiet = renderHumanError(err);
    expect(quiet).not.toContain("at ");
    expect(quiet).not.toContain(err.stack ?? "###no-stack###");
    expect(quiet).toContain("config load");
    expect(quiet).toContain("/home/bobby/.trent/config.yaml");

    process.env.TRENT_DEBUG = "1";
    const loud = renderHumanError(err);
    expect(loud).toContain("TrentError");
    expect(loud.length).toBeGreaterThan(quiet.length);
  });

  it("handles a plain Error and a thrown string without a stack", () => {
    expect(renderHumanError(new Error("kaboom"))).toContain("kaboom");
    expect(renderHumanError("kaboom")).toContain("kaboom");
    expect(renderHumanError(new Error("kaboom"))).not.toContain("at ");
  });

  it("emits no emoji in any rendered output", () => {
    const err = new TrentError({
      code: EXIT.INTERRUPT,
      operation: "run",
      message: "interrupted by the user",
      target: "run_123",
      context: { apiKey: FAKE_ANTHROPIC_KEY },
    });

    const emoji = /\p{Extended_Pictographic}/u;
    process.env.TRENT_DEBUG = "1";
    expect(emoji.test(renderHumanError(err))).toBe(false);
    expect(emoji.test(renderJsonError(err))).toBe(false);
  });
});
