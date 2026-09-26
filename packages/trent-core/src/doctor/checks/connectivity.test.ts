/**
 * G13: the connectivity check resolves the configured provider's real host. A local provider is
 * checked at its local URL and no cloud host is resolved; a hosted one resolves its own API host,
 * not api.openai.com whatever the provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import type { DoctorContext, FetchLike } from "../types.js";
import { checkConnectivity } from "./connectivity.js";

let tempDir: string;
let configManager: ConfigManager;
let lookedUp: string[];
let fetched: string[];

function useProvider(provider: string): void {
  configManager.saveConfig({ ...configManager.loadConfig(), provider: provider as never });
}

const lookupHost = async (host: string): Promise<unknown> => {
  lookedUp.push(host);
  return { address: "192.0.2.1", family: 4 };
};

const answering: FetchLike = async (url) => {
  fetched.push(url);
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
};

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 500,
  env: {},
  lookupHost,
  fetchImpl: answering,
  ...over,
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-connectivity-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
  lookedUp = [];
  fetched = [];
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("connectivity check", () => {
  it("under a local provider checks the local URL and resolves no cloud host", async () => {
    useProvider("ollama");
    const result = await checkConnectivity.run(context({ env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" } }));
    expect(result.status).toBe("ok");
    expect(result.message).toContain("http://127.0.0.1:11434/v1");
    expect(lookedUp).toEqual([]);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((url) => url.startsWith("http://127.0.0.1:11434/"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("api.openai.com");
  });

  it("under a local provider warns, naming the URL, when nothing answers there", async () => {
    useProvider("lmstudio");
    const refused: FetchLike = async (url) => {
      fetched.push(url);
      throw new TypeError("fetch failed");
    };
    const result = await checkConnectivity.run(context({ fetchImpl: refused }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("http://127.0.0.1:1234/v1");
    expect(result.fixHint).toBeTruthy();
    expect(lookedUp).toEqual([]);
  });

  it("under a hosted provider resolves that provider's own API host", async () => {
    useProvider("google");
    const google = await checkConnectivity.run(context());
    expect(google.status).toBe("ok");
    expect(lookedUp).toEqual(["generativelanguage.googleapis.com"]);
    expect(google.message).toContain("generativelanguage.googleapis.com");

    lookedUp = [];
    useProvider("anthropic");
    await checkConnectivity.run(context());
    expect(lookedUp).toEqual(["api.anthropic.com"]);

    lookedUp = [];
    useProvider("groq");
    await checkConnectivity.run(context());
    expect(lookedUp).toEqual(["api.groq.com"]);
    expect(fetched).toEqual([]);
  });

  it("follows a base URL the operator moved, as the runtime does", async () => {
    useProvider("openai");
    await checkConnectivity.run(context({ env: { OPENAI_BASE_URL: "https://proxy.example.test/v1" } }));
    expect(lookedUp).toEqual(["proxy.example.test"]);
  });

  it("warns, naming the host, when DNS cannot resolve it", async () => {
    useProvider("anthropic");
    const failing = async (host: string): Promise<unknown> => {
      lookedUp.push(host);
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    const result = await checkConnectivity.run(context({ lookupHost: failing }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("api.anthropic.com");
    expect(result.fixHint).toBeTruthy();
  });
});
