/**
 * [C9] A keyless first run finds the model already on the machine.
 *
 * With no provider key, quick setup used to stop with "Set OPENAI_API_KEY" while an Ollama with a
 * usable model sat on loopback. Now, when `trent setup --mode local` would work right now (L2's
 * detection and model choice, `setup/local-detect.ts` + `setup/local-plan.ts`), the stop still exits 3
 * with `reason: "no-key"`, and also says `suggested: "local"` and prints `trent setup --mode local`
 * as the first thing to run. With no runtime, or none with a model that can call tools, nothing changes.
 *
 * A real `node:http` server on 127.0.0.1 plays Ollama (`local-fakes.test-helpers.ts`), found through
 * OLLAMA_BASE_URL; LM Studio's URL is a closed port. Every provider key variable is emptied, and
 * TRENT_HOME is a fresh directory, so no config exists and bare `trent` is a first run. Only the
 * runtime's GET routes are served: nothing here reaches a model.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@trent/core/errors/index.js";
import { PROVIDER_ENV_VARS } from "@trent/core/setup/detect.js";
import { CHAT_CAPS, fakeLocal, type FakeOllamaModel } from "@trent/core/setup/local-fakes.test-helpers.js";
import { runCli } from "../index.js";

const LOCAL_COMMAND = "trent setup --mode local";
const CLOSED = "http://127.0.0.1:9/v1";

type SetupDoc = { success: boolean; reason?: string; suggested?: string; message: string };

let home = "";
let server: http.Server | undefined;

/** Serve `models` as Ollama 0.32.9 lists them, on an ephemeral loopback port; returns its origin. */
async function fakeOllama(models: readonly FakeOllamaModel[]): Promise<string> {
  let origin = "";
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length === 0 || req.method === "GET" ? undefined : Buffer.concat(chunks).toString("utf8");
      void fake.handle(new Request(`${origin}${req.url ?? "/"}`, { method: req.method ?? "GET", ...(body ? { body } : {}) })).then(async (answer) => {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = fakeLocal({ ollama: { url: origin, models } });
  vi.stubEnv("OLLAMA_BASE_URL", `${origin}/v1`);
  return origin;
}

const USABLE: readonly FakeOllamaModel[] = [
  { name: "qwen3.5:9b", capabilities: [...CHAT_CAPS] },
  { name: "qwen3-embedding:0.6b", capabilities: ["embedding"] },
];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-keyless-"));
  vi.stubEnv("TRENT_HOME", home);
  for (const name of Object.values(PROVIDER_ENV_VARS).flat()) vi.stubEnv(name, "");
  vi.stubEnv("OLLAMA_BASE_URL", CLOSED);
  vi.stubEnv("LMSTUDIO_BASE_URL", CLOSED);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("[C9] trent setup --json with no key", () => {
  it("with a local runtime that has a tools-capable model: exit 3, no-key, suggested local, and the command", async () => {
    const origin = await fakeOllama(USABLE);
    const result = await runCli(["setup", "--json"]);

    expect(result.exitCode, result.stderr).toBe(EXIT.CONFIG);
    const doc = JSON.parse(result.stdout) as SetupDoc;
    expect(doc.success).toBe(false);
    expect(doc.reason).toBe("no-key");
    expect(doc.suggested).toBe("local");
    expect(doc.message).toContain(LOCAL_COMMAND);
    expect(doc.message).toContain(origin);
    expect(doc.message).toContain("qwen3.5:9b");
    // The guidance goes to stderr under --json, and leads with the same command.
    expect(result.stderr).toContain(LOCAL_COMMAND);
  });

  it("with no local runtime: today's message and exit code, and no suggestion", async () => {
    const result = await runCli(["setup", "--json"]);

    expect(result.exitCode).toBe(EXIT.CONFIG);
    const doc = JSON.parse(result.stdout) as SetupDoc;
    expect(doc.reason).toBe("no-key");
    expect(doc.suggested).toBeUndefined();
    expect(doc.message).toBe(
      `No provider key found. Set OPENAI_API_KEY (or another provider variable listed above) in your environment or in ${path.join(home, ".env")}, then run setup again.`,
    );
    expect(result.stderr).not.toContain(LOCAL_COMMAND);
  });

  it("with a runtime whose only chat model cannot call tools (and a cloud model): no suggestion", async () => {
    await fakeOllama([
      { name: "qwen3.8-27b-abliterated:latest", capabilities: ["completion"] },
      { name: "nemotron-3-ultra:cloud", capabilities: [...CHAT_CAPS], remote: true },
      { name: "qwen3-embedding:0.6b", capabilities: ["embedding"] },
    ]);
    const result = await runCli(["setup", "--json"]);

    expect(result.exitCode).toBe(EXIT.CONFIG);
    const doc = JSON.parse(result.stdout) as SetupDoc;
    expect(doc.reason).toBe("no-key");
    expect(doc.suggested).toBeUndefined();
    expect(doc.message).not.toContain(LOCAL_COMMAND);
  });
});

describe("[C9] bare trent, first run, no key", () => {
  it("prints `trent setup --mode local` as its first suggestion, and --json carries suggested local", async () => {
    await fakeOllama(USABLE);
    let opened = 0;
    const result = await runCli([], { overrides: { startRepl: async () => void (opened += 1) } });

    expect(result.exitCode, result.stderr).toBe(EXIT.OK);
    expect(opened).toBe(1); // no key still opens the REPL, degraded
    const first = result.stdout.indexOf("trent setup");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(result.stdout.indexOf(LOCAL_COMMAND)).toBe(first);
    expect(first).toBeLessThan(result.stdout.indexOf("OPENAI_API_KEY"));

    fs.rmSync(path.join(home, "config.yaml"), { force: true });
    const json = await runCli(["--json"]);
    expect(json.exitCode).toBe(EXIT.CONFIG);
    const doc = JSON.parse(json.stdout) as { firstRun: boolean; setup: SetupDoc };
    expect(doc.firstRun).toBe(true);
    expect(doc.setup.suggested).toBe("local");
    expect(doc.setup.message).toContain(LOCAL_COMMAND);
  });
});
