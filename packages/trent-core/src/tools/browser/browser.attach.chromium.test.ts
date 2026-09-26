/**
 * [H5] The one real attach. A THROWAWAY Chromium plays the owner's Chrome: started by this test,
 * headless, with `--remote-debugging-port=0` on a temporary `--user-data-dir` that is deleted
 * afterwards. It is never the owner's real profile. A hostname that resolves nowhere is mapped to a
 * local fixture server inside that Chromium only (`--host-resolver-rules`), so the adapter's SSRF
 * floor sees a public name (the injected lookup) while the page is served from this process.
 *
 * It holds two tabs, an empty one and "the owner's" page, so the test can prove the empty tab is
 * the one used and the owner's is left alone, before and after detaching.
 *
 * Skipped, not passed, when no Chromium is installed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBoundApprovalStore, type BoundApprovalStore } from "../../governance/bound-approvals.js";
import { readAttachAudit, verifyAttachAudit } from "./attach-audit.js";
import { findChromium } from "./chromium.js";
import { createBrowserAdapter } from "./index.js";

const HOST = "attach-test.example";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const EGRESS = { proxyUrl: "http://127.0.0.1:9", token: "trent-tok-never-sent", caPem: "" };
const chromiumPath = findChromium(process.env);
if (!chromiumPath) console.error("[browser.attach.chromium] SKIPPED: no Chromium found. A skip is NOT a pass.");

const ACCOUNT_PAGE =
  "<html><head><title>Account</title></head><body>" +
  "<button id=\"send\" onclick=\"fetch('/clicked').then(function(){document.title='Clicked'})\">Send</button>" +
  '<input name="subject" placeholder="Subject"><input type="password" name="pw" placeholder="Password">' +
  "</body></html>";

async function until<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function refOf(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const ref = line ? /\[(@e\d+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`no ref matching ${pattern} in:\n${snapshot}`);
  return ref;
}

describe.skipIf(!chromiumPath)("browser attach (real throwaway Chromium over CDP)", () => {
  const hits: string[] = [];
  let server: http.Server;
  let origin: string;
  let child: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let profileDir: string;
  let store: BoundApprovalStore;
  let adapter: ReturnType<typeof createBrowserAdapter>;
  let snapshot = "";

  const pageUrls = async (): Promise<string[]> => {
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as { type: string; url: string }[];
    return list.filter((target) => target.type === "page").map((target) => target.url).sort();
  };

  function approveOnly(): string {
    const rows = store.list();
    expect(rows).toHaveLength(1);
    store.decide(rows[0]!.id, "approved", "owner");
    return rows[0]!.details.preview;
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/clicked") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/owner" ? "<html><head><title>Owner Tab</title></head><body><p>the owner's own page</p></body></html>" : ACCOUNT_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://${HOST}:${port}`;

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-attach-chrome-"));
    child = spawn(
      chromiumPath!,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
        // Headless Chrome takes one start URL ("Multiple targets are not supported"); the owner's
        // tab is opened next through the DevTools HTTP endpoint, as a second window would be.
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const cdpPort = await until(async () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").split("\n")[0] || undefined : undefined), "DevToolsActivePort");
    cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await until(async () => ((await pageUrls()).length === 1 ? true : undefined), "the empty starting tab");
    const opened = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(`${origin}/owner`)}`, { method: "PUT" });
    expect(opened.ok).toBe(true);
    await until(async () => {
      const urls = await pageUrls();
      return urls.length === 2 && urls.includes(`${origin}/owner`) ? urls : undefined;
    }, "the two starting tabs");

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-attach-profile-"));
    store = createBoundApprovalStore({ profileDir });
    adapter = createBrowserAdapter({
      profileDir,
      runId: "run_attach_chromium",
      egress: EGRESS,
      executablePath: null,
      lookup: PUBLIC_LOOKUP,
      attach: { enabled: true, cdp_url: cdpUrl, profile_hint: "throwaway" },
      allowedHosts: [HOST],
      bindings: store,
    });
  }, 60_000);

  afterAll(async () => {
    await adapter?.cleanup();
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }, 30_000);

  it("attaches through the existing empty tab once a human approves the navigation, leaving the owner's tab alone", async () => {
    const action = `browser_navigate {"url":"${origin}/account","attach":true}`;
    const parked = await adapter.execute(action, {});
    expect(parked.status, parked.summary).toBe("needs_approval");
    expect(parked.summary).toContain(`${origin}/account`);
    expect(hits).not.toContain("/account");
    expect(approveOnly()).toContain("throwaway");

    const done = await adapter.execute(action, {});
    expect(done.status, done.summary).toBe("completed");
    expect(done.summary).toContain("Account");
    expect(hits).toContain("/account");
    // Still two tabs: the empty one now shows the account page; the owner's is where it was.
    expect(await pageUrls()).toEqual([`${origin}/account`, `${origin}/owner`]);
  }, 60_000);

  it("snapshots the attached tab without asking", async () => {
    const result = await adapter.execute("browser_snapshot {}", {});
    expect(result.status, result.summary).toBe("completed");
    expect(result.summary).toContain('"Send"');
    expect(store.list()).toEqual([]);
    snapshot = result.summary;
  }, 30_000);

  it("parks a click until a human approves it, and the page sees nothing until then", async () => {
    const action = `browser_click {"ref":"${refOf(snapshot, /"Send"/)}"}`;
    const parked = await adapter.execute(action, {});
    expect(parked.status, parked.summary).toBe("needs_approval");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hits).not.toContain("/clicked");
    const preview = approveOnly();
    expect(preview).toContain(`${origin}/account`);
    expect(preview).toContain('"Send"');

    const done = await adapter.execute(action, {});
    expect(done.status, done.summary).toBe("completed");
    await until(async () => (hits.includes("/clicked") ? true : undefined), "the click to reach the page");
  }, 60_000);

  it("refuses to type into the password field and asks nobody", async () => {
    const result = await adapter.execute(`browser_type {"ref":"${refOf(snapshot, /password input/)}","text":"hunter2"}`, {});
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/password/);
    expect(result.summary).not.toContain("hunter2");
    expect(store.list()).toEqual([]);
  }, 30_000);

  it("detaching leaves every tab open, and the audit names the site it acted on", async () => {
    await adapter.cleanup();
    const urls = await pageUrls();
    expect(urls).toHaveLength(2);
    expect(urls).toContain(`${origin}/owner`);
    expect(urls).toContain(`${origin}/account`);

    const rows = readAttachAudit(profileDir);
    expect(rows.map((row) => row.action)).toEqual(["browser.attach", "browser.navigate", "browser.click", "browser.detach"]);
    expect(rows.filter((row) => row.objectType === "browser_site").every((row) => row.objectId === origin)).toBe(true);
    expect(verifyAttachAudit(profileDir).failures).toEqual([]);
  }, 30_000);
});
