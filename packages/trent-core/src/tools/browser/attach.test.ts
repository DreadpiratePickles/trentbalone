/**
 * [H5] Attach mode against a fake CDP-connected Chrome: the floors, the bound gate, the one-shot
 * grant, the audit and the detach contract, with no Chromium. The real throwaway Chromium is in
 * `browser.attach.chromium.test.ts`; the config and the disabled default are in
 * `attach-config.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBoundApprovalStore, type BoundApprovalStore } from "../../governance/bound-approvals.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { readAttachAudit, verifyAttachAudit } from "./attach-audit.js";
import { BROWSER_TOOL_SCHEMAS, createBrowserAdapter } from "./index.js";
import type { BrowserLike, ContextLike, LocatorLike, PageLike } from "./page-types.js";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const EGRESS = { proxyUrl: "http://127.0.0.1:8089", token: "trent-tok-unit", caPem: "" };
const ATTACH = { enabled: true, cdp_url: "http://127.0.0.1:9222", profile_hint: "Work" };
const ALLOWED = ["mail.example.com", "*.shop.example"];
const COMPOSE = "https://mail.example.com/compose";
const OWNER_URL = "https://mail.example.com/inbox";

interface FakeTab {
  url: string;
  closed: boolean;
  page: PageLike;
}

interface FakeChrome {
  tabs: FakeTab[];
  connects: number;
  connectedTo: string[];
  connectError?: string;
  disconnected: boolean;
  contextClosed: boolean;
  headers: Record<string, string>[];
  launches: number;
  clicked: string[];
  filled: { ref: string; text: string }[];
  pressed: string[];
  wheel: number[];
  passwordRefs: Set<string>;
  otpRefs: Set<string>;
  focusInPassword: boolean;
}

const LABELS: Record<string, string> = { e1: "Send", e2: "Subject", e3: "Password" };

function fakeTab(chrome: FakeChrome, url: string): FakeTab {
  const tab: FakeTab = { url, closed: false, page: undefined as unknown as PageLike };
  const locator = (selector: string): LocatorLike => {
    const ref = /"([^"]+)"/.exec(selector)?.[1] ?? selector;
    return {
      count: async () => (ref in LABELS ? 1 : 0),
      click: async () => void chrome.clicked.push(ref),
      fill: async (text: string) => void chrome.filled.push({ ref, text }),
      evaluate: async () => ({
        tag: ref === "e1" ? "button" : "input",
        type: chrome.passwordRefs.has(ref) ? "password" : ref === "e1" ? "submit" : "text",
        autocomplete: chrome.otpRefs.has(ref) ? "one-time-code" : "",
        label: LABELS[ref] ?? "",
      }),
    };
  };
  const page = {
    goto: async (next: string) => {
      tab.url = next;
      return null;
    },
    goBack: async () => null,
    url: () => tab.url,
    title: async () => `Title of ${tab.url}`,
    evaluate: async (script: unknown) => {
      const source = String(script);
      if (source.includes("activeElement")) return { tag: "input", type: chrome.focusInPassword ? "password" : "text", autocomplete: "" };
      if (source.includes("innerText")) return `Text of ${tab.url}`;
      if (source.includes("trent-ref")) {
        return [
          { ref: "@e1", role: "button", name: "Send" },
          { ref: "@e2", role: "text input", name: "Subject", type: "text" },
          { ref: "@e3", role: "password input", name: "Password", type: "password" },
        ];
      }
      return null;
    },
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    keyboard: { press: async (key: string) => void chrome.pressed.push(key) },
    mouse: { wheel: async (_dx: number, dy: number) => void chrome.wheel.push(dy) },
    locator,
    on: () => undefined,
    isClosed: () => tab.closed,
    // Not on PageLike: if anything reached for it, the tab would read as closed.
    close: async () => {
      tab.closed = true;
    },
  };
  tab.page = page as PageLike;
  return tab;
}

function fakeChrome(initialUrls: readonly string[]): FakeChrome {
  const chrome: FakeChrome = {
    tabs: [],
    connects: 0,
    connectedTo: [],
    disconnected: false,
    contextClosed: false,
    headers: [],
    launches: 0,
    clicked: [],
    filled: [],
    pressed: [],
    wheel: [],
    passwordRefs: new Set(),
    otpRefs: new Set(),
    focusInPassword: false,
  };
  chrome.tabs = initialUrls.map((url) => fakeTab(chrome, url));
  return chrome;
}

function connectorFor(chrome: FakeChrome) {
  const context: ContextLike = {
    pages: () => chrome.tabs.map((tab) => tab.page),
    newPage: async () => {
      const tab = fakeTab(chrome, "about:blank");
      chrome.tabs.push(tab);
      return tab.page;
    },
    setExtraHTTPHeaders: async (headers: Record<string, string>) => void chrome.headers.push(headers),
    close: async () => {
      chrome.contextClosed = true;
    },
  };
  const browser: BrowserLike = {
    newContext: async () => {
      throw new Error("an attached browser never creates a context");
    },
    contexts: () => [context],
    close: async () => {
      chrome.disconnected = true;
    },
  };
  return async (cdpUrl: string): Promise<BrowserLike> => {
    chrome.connects += 1;
    chrome.connectedTo.push(cdpUrl);
    if (chrome.connectError) throw new Error(chrome.connectError);
    return browser;
  };
}

/** `null` leaves `attach` out of the call, the way a seat that never heard of it writes it. */
const nav = (url: string, attach: boolean | null = true): string =>
  `browser_navigate ${JSON.stringify(attach === null ? { url } : { url, attach })}`;

describe("browser attach (fake CDP-connected Chrome)", () => {
  let profileDir: string;
  let store: BoundApprovalStore;
  let chrome: FakeChrome;
  let adapter: ReturnType<typeof createBrowserAdapter>;

  const build = (overrides: Partial<Parameters<typeof createBrowserAdapter>[0]> = {}) =>
    createBrowserAdapter({
      profileDir,
      runId: "run_attach",
      egress: EGRESS,
      lookup: PUBLIC_LOOKUP,
      launcher: async () => {
        chrome.launches += 1;
        throw new Error("the launched browser is not under test here");
      },
      attach: ATTACH,
      allowedHosts: ALLOWED,
      connector: connectorFor(chrome),
      bindings: store,
      seat: "ops",
      ...overrides,
    });

  /** Approves the one pending row and returns its preview. */
  function approveOnly(): string {
    const rows = store.list();
    expect(rows).toHaveLength(1);
    store.decide(rows[0]!.id, "approved", "owner");
    return rows[0]!.details.preview;
  }

  async function attachTo(url: string): Promise<string> {
    const parked = await adapter.execute(nav(url), {});
    expect(parked.status, parked.summary).toBe("needs_approval");
    approveOnly();
    const done = await adapter.execute(nav(url), {});
    expect(done.status, done.summary).toBe("completed");
    return done.summary;
  }

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-attach-"));
    store = createBoundApprovalStore({ profileDir });
    chrome = fakeChrome([OWNER_URL, "about:blank"]);
    adapter = build();
  });

  afterEach(async () => {
    await adapter.cleanup();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("is an argument on browser_navigate, not a new tool: the tool count stays twelve", () => {
    expect(BROWSER_TOOL_SCHEMAS).toHaveLength(12);
    const navigate = BROWSER_TOOL_SCHEMAS.find((schema) => schema.name === "browser_navigate");
    const properties = (navigate?.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(properties.attach?.type).toBe("boolean");
  });

  it("parks an attached navigation until a human approves exactly it, and touches the owner's Chrome only after", async () => {
    const parked = await adapter.execute(nav(COMPOSE), {});
    expect(parked.status).toBe("needs_approval");
    expect(chrome.connects).toBe(0);
    const [row] = store.list();
    expect(row?.details.classes).toEqual(["customer_facing"]);
    expect(row?.details.preview).toContain("mail.example.com");
    expect(row?.details.preview).toContain(`open ${COMPOSE}`);
    expect(row?.details.preview).toContain("Work");
    store.decide(row!.id, "approved", "owner");

    const done = await adapter.execute(nav(COMPOSE), {});
    expect(done.status, done.summary).toBe("completed");
    expect(done.summary).toContain(`Title of ${COMPOSE}`);
    expect(chrome.connectedTo).toEqual([ATTACH.cdp_url]);
    // The empty tab was used; the owner's tab was left where it was, and no tab was opened.
    expect(chrome.tabs.map((tab) => tab.url)).toEqual([OWNER_URL, COMPOSE]);
    // The owner's own network: no proxy token header, and the launched browser never started.
    expect(chrome.headers).toEqual([]);
    expect(chrome.launches).toBe(0);
  });

  it("opens a new tab when every tab shows the owner's content, and never navigates one of them", async () => {
    chrome = fakeChrome([OWNER_URL]);
    adapter = build();
    await attachTo(COMPOSE);
    expect(chrome.tabs.map((tab) => tab.url)).toEqual([OWNER_URL, COMPOSE]);
  });

  it("an approval is spent by the one call it approved: the same click again parks a new row", async () => {
    await attachTo(COMPOSE);
    const parked = await adapter.execute('browser_click {"ref":"@e1"}', {});
    expect(parked.status).toBe("needs_approval");
    expect(chrome.clicked).toEqual([]);
    const preview = approveOnly();
    expect(preview).toContain("click @e1");
    expect(preview).toContain('"Send"');
    expect(preview).toContain(COMPOSE);

    expect((await adapter.execute('browser_click {"ref":"@e1"}', {})).status).toBe("completed");
    expect(chrome.clicked).toEqual(["e1"]);

    const again = await adapter.execute('browser_click {"ref":"@e1"}', {});
    expect(again.status).toBe("needs_approval");
    expect(chrome.clicked).toEqual(["e1"]);
    expect(store.list()).toHaveLength(1);
  });

  it("gates every action that changes the tab: type, press, scroll and back each park first", async () => {
    await attachTo(COMPOSE);
    for (const action of ['browser_type {"ref":"@e2","text":"Quarterly numbers"}', 'browser_press {"key":"Enter"}', 'browser_scroll {"direction":"down"}', "browser_back {}"]) {
      const parked = await adapter.execute(action, {});
      expect(parked.status, action).toBe("needs_approval");
    }
    expect(chrome.filled).toEqual([]);
    expect(chrome.pressed).toEqual([]);
    expect(chrome.wheel).toEqual([]);
    const typed = store.list().find((row) => row.details.tool === "browser_type");
    expect(typed?.details.preview).toContain('type "Quarterly numbers" into @e2');
  });

  it("reads are not actions: snapshot, page text and screenshot run without an approval", async () => {
    await attachTo(COMPOSE);
    const snapshot = await adapter.execute("browser_snapshot {}", {});
    expect(snapshot.status).toBe("completed");
    expect(snapshot.summary).toContain('"Send"');
    expect((await adapter.execute("browser_get_text {}", {})).status).toBe("completed");
    expect((await adapter.execute("browser_screenshot {}", {})).status).toBe("completed");
    expect(store.list()).toEqual([]);
  });

  it("a seat's step approval grants the replay dryRun stamped, inside the same turn", async () => {
    await attachTo(COMPOSE);
    const action = 'browser_click {"ref":"@e1"}';
    expect(adapter.requiresApproval(action)).toBe(true);
    await runWithToolCallContext({ runId: "run_1", stepId: "step_1" }, async () => {
      const dry = await adapter.dryRun!(action, {});
      expect(dry.status).toBe("needs_approval");
      expect(dry.summary).toContain('"Send"');
      expect(store.list()[0]?.details.previewedAt).toBeDefined();
      const ran = await adapter.execute(action, {});
      expect(ran.status, ran.summary).toBe("completed");
    });
    expect(chrome.clicked).toEqual(["e1"]);
  });

  it("refuses a password field before any approval row exists, and never fills it", async () => {
    await attachTo(COMPOSE);
    chrome.passwordRefs.add("e3");
    const refused = await adapter.execute('browser_type {"ref":"@e3","text":"hunter2"}', {});
    expect(refused.status).toBe("blocked");
    expect(refused.summary).toMatch(/password/);
    expect(refused.summary).not.toContain("hunter2");
    chrome.otpRefs.add("e2");
    const otp = await adapter.execute('browser_type {"ref":"@e2","text":"123456"}', {});
    expect(otp.status).toBe("blocked");
    expect(store.list()).toEqual([]);
    expect(chrome.filled).toEqual([]);
  });

  it("refuses a key press while focus is in a password field", async () => {
    await attachTo(COMPOSE);
    chrome.focusInPassword = true;
    const refused = await adapter.execute('browser_press {"key":"a"}', {});
    expect(refused.status).toBe("blocked");
    expect(refused.summary).toMatch(/password/);
    expect(store.list()).toEqual([]);
    expect(chrome.pressed).toEqual([]);
  });

  it("refuses JavaScript in the owner's logged-in page, and still reads the console", async () => {
    await attachTo(COMPOSE);
    const refused = await adapter.execute('browser_console {"expression":"document.cookie"}', {});
    expect(refused.status).toBe("blocked");
    expect(refused.summary).toMatch(/cookies/);
    expect((await adapter.execute("browser_console {}", {})).status).toBe("completed");
  });

  it("applies the SSRF floor and the egress allowlist to an attached navigation before connecting", async () => {
    const metadata = await adapter.execute(nav("http://169.254.169.254/latest/meta-data/"), {});
    expect(metadata.status).toBe("blocked");
    const outside = await adapter.execute(nav("https://bank.example/"), {});
    expect(outside.status).toBe("blocked");
    expect(outside.summary).toContain("egress.intercept_domains");
    expect(store.list()).toEqual([]);
    const wildcard = await adapter.execute(nav("https://www.shop.example/cart"), {});
    expect(wildcard.status).toBe("needs_approval");
    expect(chrome.connects).toBe(0);
  });

  it("refuses a DevTools endpoint that is not on this machine", async () => {
    adapter = build({ attach: { enabled: true, cdp_url: "http://10.0.0.5:9222" } });
    const refused = await adapter.execute(nav(COMPOSE), {});
    expect(refused.status).toBe("blocked");
    expect(refused.summary).toMatch(/loopback/);
    expect(chrome.connects).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("refuses to read or act once the tab has left the allowlist", async () => {
    await attachTo(COMPOSE);
    chrome.tabs[1]!.url = "https://evil.example/landing";
    const click = await adapter.execute('browser_click {"ref":"@e1"}', {});
    expect(click.status).toBe("blocked");
    expect(click.summary).toContain("evil.example");
    expect((await adapter.execute("browser_snapshot {}", {})).status).toBe("blocked");
    expect(store.list()).toEqual([]);
  });

  it("records each site it acted on in a hash-chained audit, never the typed text", async () => {
    await attachTo(COMPOSE);
    await adapter.execute('browser_type {"ref":"@e2","text":"Quarterly numbers"}', {});
    approveOnly();
    expect((await adapter.execute('browser_type {"ref":"@e2","text":"Quarterly numbers"}', {})).status).toBe("completed");
    await adapter.cleanup();
    const rows = readAttachAudit(profileDir);
    expect(rows.map((row) => row.action)).toEqual(["browser.attach", "browser.navigate", "browser.type", "browser.detach"]);
    expect(rows.filter((row) => row.objectType === "browser_site").map((row) => row.objectId)).toEqual(["https://mail.example.com", "https://mail.example.com"]);
    expect(rows.every((row) => row.actor === "ops")).toBe(true);
    expect(rows[2]?.summary).toContain(COMPOSE);
    expect(JSON.stringify(rows)).not.toContain("Quarterly numbers");
    expect(verifyAttachAudit(profileDir).failures).toEqual([]);
    expect(fs.statSync(path.join(profileDir, "browser", "attach-audit.ndjson")).mode & 0o777).toBe(0o600);
  });

  it("detaching disconnects and closes no tab and no window", async () => {
    await attachTo(COMPOSE);
    await adapter.cleanup();
    expect(chrome.disconnected).toBe(true);
    expect(chrome.contextClosed).toBe(false);
    expect(chrome.tabs.map((tab) => [tab.url, tab.closed])).toEqual([
      [OWNER_URL, false],
      [COMPOSE, false],
    ]);
  });

  it("says how to start Chrome when nothing is listening on the DevTools port", async () => {
    chrome.connectError = "browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222";
    await adapter.execute(nav(COMPOSE), {});
    approveOnly();
    const failed = await adapter.execute(nav(COMPOSE), {});
    expect(failed.status).toBe("failed");
    expect(failed.summary).toContain("--remote-debugging-port");
    expect(failed.summary).toContain(ATTACH.cdp_url);
  });

  it("without attach the navigation is the isolated launched browser, ungated, as before", async () => {
    const launched = await adapter.execute(nav("https://example.com/", null), {});
    expect(chrome.launches).toBe(1);
    expect(launched.status).toBe("failed");
    expect(store.list()).toEqual([]);
    expect(chrome.connects).toBe(0);
    expect(adapter.requiresApproval(nav("https://example.com/", null))).toBe(false);
    expect(adapter.requiresApproval(nav(COMPOSE))).toBe(true);
  });
});
