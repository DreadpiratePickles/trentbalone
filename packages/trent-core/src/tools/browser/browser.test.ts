/**
 * The `browser` toolset against a fake Playwright `Browser`: the floors and the output contract
 * are asserted without a Chromium. The real launch through a real EgressProxy is in
 * `browser.chromium.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_ADAPTER_NAME, BROWSER_TOOL_SCHEMAS, createBrowserAdapter } from "./index.js";
import type { BrowserLike, ContextLike, LocatorLike, PageLike } from "./page-types.js";
import { SNAPSHOT_LIMIT } from "./schemas.js";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const EGRESS = { proxyUrl: "http://127.0.0.1:8089", token: "trent-tok-unit", caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" };

interface FakeState {
  launches: number;
  contextOptions: unknown[];
  headers: Record<string, string>[];
  gotos: string[];
  clicked: string[];
  filled: { ref: string; text: string }[];
  pressed: string[];
  wheel: number[];
  screenshots: { path?: string; fullPage?: boolean }[];
  closed: boolean;
  text: string;
  passwordRefs: Set<string>;
  consoleHandlers: ((msg: { type(): string; text(): string }) => void)[];
}

function fakeBrowser(state: FakeState): BrowserLike {
  const locator = (selector: string): LocatorLike => {
    const ref = /"([^"]+)"/.exec(selector)?.[1] ?? selector;
    return {
      count: async () => 1,
      click: async () => {
        state.clicked.push(ref);
      },
      fill: async (text: string) => {
        state.filled.push({ ref, text });
      },
      evaluate: async () => ({ tag: "input", type: state.passwordRefs.has(ref) ? "password" : "text" }),
    };
  };
  const page: PageLike = {
    goto: async (url: string) => {
      state.gotos.push(url);
      return null;
    },
    goBack: async () => null,
    url: () => state.gotos.at(-1) ?? "about:blank",
    title: async () => "Fake Page",
    evaluate: async (script: unknown) => {
      const source = typeof script === "string" ? script : String(script);
      if (source.includes("innerText")) return state.text;
      if (source.includes("trent-ref")) return [{ ref: "@e1", role: "button", name: "Go" }, { ref: "@e2", role: "input", name: "Search", type: "text" }];
      if (source.includes("images")) return [{ src: "https://example.com/a.png", alt: "A" }];
      return null;
    },
    screenshot: async (options: { path?: string; fullPage?: boolean }) => {
      state.screenshots.push(options);
      if (options.path) fs.writeFileSync(options.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    keyboard: { press: async (key: string) => void state.pressed.push(key) },
    mouse: { wheel: async (_dx: number, dy: number) => void state.wheel.push(dy) },
    locator,
    on: (event: string, handler: (arg: never) => void) => {
      if (event === "console") state.consoleHandlers.push(handler as FakeState["consoleHandlers"][number]);
    },
    isClosed: () => state.closed,
  };
  const context: ContextLike = {
    newPage: async () => page,
    setExtraHTTPHeaders: async (headers: Record<string, string>) => void state.headers.push(headers),
    close: async () => undefined,
  };
  return {
    newContext: async (options: unknown) => {
      state.contextOptions.push(options);
      return context;
    },
    close: async () => {
      state.closed = true;
    },
  };
}

function freshState(): FakeState {
  return {
    launches: 0,
    contextOptions: [],
    headers: [],
    gotos: [],
    clicked: [],
    filled: [],
    pressed: [],
    wheel: [],
    screenshots: [],
    closed: false,
    text: "Hello from the fake page",
    passwordRefs: new Set(),
    consoleHandlers: [],
  };
}

describe("browser toolset (fake Playwright browser)", () => {
  let profileDir: string;
  let state: FakeState;
  let adapter: ReturnType<typeof createBrowserAdapter>;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-browser-"));
    state = freshState();
    adapter = createBrowserAdapter({
      profileDir,
      runId: "run_unit",
      egress: EGRESS,
      lookup: PUBLIC_LOOKUP,
      launcher: async () => {
        state.launches += 1;
        return fakeBrowser(state);
      },
    });
  });

  afterEach(async () => {
    await adapter.cleanup();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("uses Hermes's tool names and marks itself real", () => {
    const names = BROWSER_TOOL_SCHEMAS.map((s) => s.name);
    for (const name of ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_back", "browser_press", "browser_get_images", "browser_vision", "browser_console", "browser_screenshot", "browser_get_text"]) {
      expect(names).toContain(name);
    }
    expect(adapter.name).toBe(BROWSER_ADAPTER_NAME);
    expect(adapter.availability).toBe("real");
    expect(adapter.instructions).toContain("browser_navigate");
    expect(adapter.scopes).toContain("browser_click");
  });

  it("refuses a cloud-metadata address before any browser is launched", async () => {
    const result = await adapter.execute('browser_navigate {"url":"http://169.254.169.254/latest/meta-data/"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/metadata/i);
    expect(state.launches).toBe(0);
  });

  it("refuses a non-http(s) scheme and a loopback host", async () => {
    const file = await adapter.execute('browser_navigate {"url":"file:///etc/passwd"}', {});
    expect(file.status).toBe("blocked");
    expect(file.summary).toMatch(/scheme/);
    const loop = await adapter.execute('browser_navigate {"url":"http://localhost:3000/"}', {});
    expect(loop.status).toBe("blocked");
    expect(state.launches).toBe(0);
  });

  it("launches once, through the egress proxy, with the broker token as a header, and returns a snapshot", async () => {
    const result = await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    expect(result.status).toBe("completed");
    expect(state.launches).toBe(1);
    expect(state.gotos).toEqual(["https://example.com/"]);
    expect(state.headers[0]).toEqual({ "x-trent-proxy-token": EGRESS.token });
    expect(result.summary).toContain("Fake Page");
    expect(result.summary).toContain("@e1");
    // A second navigation reuses the session.
    await adapter.execute('browser_navigate {"url":"https://example.org/"}', {});
    expect(state.launches).toBe(1);
  });

  it("requires browser_navigate before the other tools", async () => {
    const result = await adapter.execute('browser_click {"ref":"@e1"}', {});
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/browser_navigate/);
  });

  it("clicks, types, presses and scrolls by ref", async () => {
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    expect((await adapter.execute('browser_click {"ref":"@e1"}', {})).status).toBe("completed");
    expect(state.clicked).toEqual(["e1"]);
    expect((await adapter.execute('browser_type {"ref":"@e2","text":"hello"}', {})).status).toBe("completed");
    expect(state.filled).toEqual([{ ref: "e2", text: "hello" }]);
    expect((await adapter.execute('browser_press {"key":"Enter"}', {})).status).toBe("completed");
    expect(state.pressed).toEqual(["Enter"]);
    expect((await adapter.execute('browser_scroll {"direction":"down"}', {})).status).toBe("completed");
    expect(state.wheel[0]).toBeGreaterThan(0);
    expect((await adapter.execute('browser_scroll {"direction":"sideways"}', {})).status).toBe("failed");
  });

  it("refuses to type into a password field and never sends the text", async () => {
    state.passwordRefs.add("e2");
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    const result = await adapter.execute('browser_type {"ref":"@e2","text":"hunter2"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/password/);
    expect(result.summary).not.toContain("hunter2");
    expect(state.filled).toEqual([]);
  });

  it("writes screenshots under <profileDir>/browser/<runId>/ and returns the path, not base64", async () => {
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    const result = await adapter.execute("browser_screenshot {}", {});
    expect(result.status).toBe("completed");
    const match = /(\S+\.png)/.exec(result.summary);
    expect(match).not.toBeNull();
    const file = match![1]!;
    expect(file.startsWith(path.join(profileDir, "browser", "run_unit"))).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(result.summary).not.toMatch(/base64/);
    expect(state.screenshots[0]?.path).toBe(file);
  });

  it("caps browser_get_text by the spillover rule and saves the full text", async () => {
    state.text = `HEAD-MARK ${"x".repeat(SNAPSHOT_LIMIT * 3)} TAIL-MARK`;
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    const result = await adapter.execute("browser_get_text {}", {});
    expect(result.status).toBe("completed");
    expect(result.summary.length).toBeLessThan(SNAPSHOT_LIMIT + 1_000);
    expect(result.summary).toContain("HEAD-MARK");
    expect(result.summary).toContain("TAIL-MARK");
    const spilled = /saved to (\S+\.txt)/.exec(result.summary)?.[1];
    expect(spilled).toBeDefined();
    expect(fs.readFileSync(spilled!, "utf8").length).toBeGreaterThan(SNAPSHOT_LIMIT * 3);
  });

  it("returns console messages captured since navigation", async () => {
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    for (const handler of state.consoleHandlers) handler({ type: () => "error", text: () => "boom happened" });
    const result = await adapter.execute("browser_console {}", {});
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("[error] boom happened");
  });

  it("browser_vision screenshots and asks the vision callback with the question", async () => {
    const asked: { question: string; mime: string; bytes: number }[] = [];
    const seeing = createBrowserAdapter({
      profileDir,
      runId: "run_vision",
      egress: EGRESS,
      lookup: PUBLIC_LOOKUP,
      launcher: async () => fakeBrowser(state),
      vision: async (input) => {
        asked.push({ question: input.question, mime: input.mimeType, bytes: input.image.length });
        return "The page shows a heading.";
      },
    });
    await seeing.execute('browser_navigate {"url":"https://example.com/"}', {});
    const result = await seeing.execute('browser_vision {"question":"What is on the page?"}', {});
    expect(result.status).toBe("completed");
    expect(asked).toEqual([{ question: "What is on the page?", mime: "image/png", bytes: 4 }]);
    expect(result.summary).toContain("The page shows a heading.");
    expect(result.summary).toMatch(/screenshot_path: \S+\.png/);
    await seeing.cleanup();
  });

  it("closes the browser on cleanup", async () => {
    await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    await adapter.cleanup();
    expect(state.closed).toBe(true);
  });
});

describe("browser toolset without a Chromium", () => {
  it("reports not_available with the install hint instead of pretending", async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-browser-none-"));
    const adapter = createBrowserAdapter({ profileDir, runId: "run_none", egress: EGRESS, executablePath: null });
    expect(adapter.availability).toBe("unavailable");
    const result = await adapter.execute('browser_navigate {"url":"https://example.com/"}', {});
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/not_available/);
    expect(result.summary).toMatch(/TRENT_BROWSER_PATH/);
    await adapter.cleanup();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });
});

describe("buildTrentTools wires browser and vision", () => {
  it("builds browser behind egress and vision behind a gateway; browser is skipped with a reason, vision is unavailable", async () => {
    const { buildTrentTools } = await import("../index.js");
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-build-bv-"));
    const caCertPath = path.join(profileDir, "ca.pem");
    fs.writeFileSync(caCertPath, EGRESS.caPem);
    const none = buildTrentTools({ toolsets: ["browser", "vision"], disabled_toolsets: [] }, { workspace: profileDir, profileDir, backend: "local" });
    expect(none.adapters.map((a) => `${a.name}:${a.availability}`)).toEqual(["vision:unavailable"]);
    expect(none.skipped.map((s) => s.toolset)).toEqual(["browser"]);
    expect(none.skipped[0]?.reason).toMatch(/egress/i);
    const noModel = await none.adapters[0]!.execute('vision_analyze {"image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==","question":"?"}', {});
    expect(noModel.status).toBe("failed");
    expect(noModel.summary).toMatch(/not_available/);

    const gateway = { resolveRoute: () => ({ providers: [], fallbackChain: [], modelTier: "sonnet" as const, explicitModel: "", modelForProvider: () => "m" }), complete: async () => { throw new Error("unused"); } };
    const both = buildTrentTools(
      { toolsets: ["browser", "vision"], disabled_toolsets: [] },
      { workspace: profileDir, profileDir, backend: "local", egress: { proxyUrl: EGRESS.proxyUrl, token: EGRESS.token, caCertPath }, gateway },
    );
    expect(both.adapters.map((a) => a.name)).toEqual(["browser", "vision"]);
    expect(both.skipped).toEqual([]);
    await Promise.all(both.adapters.map((a) => a.cleanup()));
    fs.rmSync(profileDir, { recursive: true, force: true });
  });
});
