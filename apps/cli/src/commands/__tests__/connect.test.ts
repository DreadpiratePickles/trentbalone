/**
 * `trent connect <provider>|list|remove|refresh`: the credential flow the toolsets execute
 * against real accounts with. The contract a script depends on: a value entered here lands in
 * the profile secrets file at 0600 and nowhere else, every output (`--json` or human, stdout
 * or stderr) names providers and scopes and never a value, the OAuth flow refuses a callback
 * whose state it did not send, and `trent security audit` sees the result as secrets in the
 * right file rather than a credential in `config.yaml`.
 *
 * The OAuth tests run against a local authorization server; no test here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { FakeOAuthServer, fakeBrowser } from "@trent/core/connect/testing/fake-oauth-server.js";
import { EXIT } from "@trent/core/errors/index.js";
import { ScriptedPrompts } from "@trent/core/setup/index.js";
import { runCli } from "../index.js";
import { setConnectDeps } from "../groups/connect.js";

const CLIENT_ID = "client-id-cli.apps";
const CLIENT_SECRET = "client-secret-cli-0123456789abcdef";
const STRIPE_KEY = "sk_test_cli_connect_0123456789abcdef";
const TWILIO_SID = "ACcli0000000000000000000000000001";
const TWILIO_TOKEN = "twilio-auth-token-cli-0123456789";

let home: string;
let server: FakeOAuthServer;

const ENV_NAMES = ["MY_STRIPE_KEY", "MY_TWILIO_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-connect-")));
  process.env.TRENT_HOME = home;
  fs.writeFileSync(path.join(home, "config.yaml"), ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", ""].join("\n"), { mode: 0o644 });
  server = new FakeOAuthServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await server.start();
  setConnectDeps({ endpoints: { google: server.endpoints }, openBrowser: (url) => void fakeBrowser(url), interactive: false });
});

afterEach(async () => {
  setConnectDeps(null);
  await server.stop();
  delete process.env.TRENT_HOME;
  for (const name of Object.keys(process.env)) {
    if (/^(GOOGLE|STRIPE|TWILIO|BLUESKY|META|SQUARE|BUFFER)_/.test(name) || ENV_NAMES.includes(name)) delete process.env[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const secretsFile = (): string => fs.readFileSync(path.join(home, ".env"), "utf8");
const json = <T>(stdout: string): T => JSON.parse(stdout) as T;

function everyIssuedToken(): string[] {
  return [...server.issued.accessTokens, ...server.issued.refreshTokens, ...server.issued.codes];
}

describe("dry runs and listings", () => {
  it("lists the providers with no argument, and answers a dry run for any id with exit 0", async () => {
    const bare = await runCli(["connect", "--json"]);
    expect(bare.exitCode).toBe(EXIT.OK);
    const listing = json<{ providers: { provider: string; kind: string; connected: boolean }[] }>(bare.stdout);
    expect(listing.providers.map((p) => p.provider)).toEqual(["stripe", "google", "square", "twilio", "buffer", "meta", "bluesky"]);
    expect(listing.providers.every((p) => p.connected === false)).toBe(true);

    for (const argv of [["connect", "sample"], ["connect", "remove", "sample"], ["connect", "refresh", "sample"], ["connect", "google"]]) {
      const result = await runCli([...argv, "--json", "--dry-run"]);
      expect(result.exitCode, argv.join(" ")).toBe(EXIT.OK);
      expect(json<{ dryRun: boolean; known: boolean }>(result.stdout)).toMatchObject({ dryRun: true, known: argv.at(-1) === "google" });
    }
    expect(fs.existsSync(path.join(home, ".env"))).toBe(false);
  });

  it("refuses an unknown provider as a usage error that names the known ones", async () => {
    const result = await runCli(["connect", "paypal", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toContain("stripe");
    expect(result.stdout).toContain("bluesky");
  });
});

describe("an api_key provider", () => {
  it("takes the key from a named environment variable and writes it to the secrets file at 0600", async () => {
    process.env.MY_STRIPE_KEY = STRIPE_KEY;

    const result = await runCli(["connect", "stripe", "--from-env", "MY_STRIPE_KEY", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(json<{ provider: string; kind: string; written: string[] }>(result.stdout)).toMatchObject({ provider: "stripe", kind: "api_key", written: ["STRIPE_SECRET_KEY"] });
    expect(result.stdout + result.stderr).not.toContain(STRIPE_KEY);
    expect(fs.statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(secretsFile()).toContain(`STRIPE_SECRET_KEY=${STRIPE_KEY}`);
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).not.toContain(STRIPE_KEY);

    const get = await runCli(["config", "get", "STRIPE_SECRET_KEY", "--json"]);
    expect(json<{ secret: boolean; present: boolean }>(get.stdout)).toEqual({ key: "STRIPE_SECRET_KEY", secret: true, present: true });
    expect((await runCli(["config", "get", "STRIPE_SECRET_KEY"])).stdout).toContain("[set]");
  });

  it("prompts hidden when no environment variable is named, and the answer never reaches an output", async () => {
    const prompts = new ScriptedPrompts({ "stripe.STRIPE_SECRET_KEY": STRIPE_KEY });
    setConnectDeps({ prompts });

    const result = await runCli(["connect", "stripe"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(prompts.asked).toEqual([{ id: "stripe.STRIPE_SECRET_KEY", message: expect.stringContaining("Stripe secret key") }]);
    expect(result.stdout).toContain("stripe");
    expect(result.stdout + result.stderr).not.toContain(STRIPE_KEY);
    expect(secretsFile()).toContain(`STRIPE_SECRET_KEY=${STRIPE_KEY}`);
  });

  it("refuses to prompt without a terminal and names --from-env", async () => {
    const result = await runCli(["connect", "stripe", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toContain("--from-env");
    expect(fs.existsSync(path.join(home, ".env"))).toBe(false);
  });

  it("refuses an environment variable that is not set, naming it and not its neighbours", async () => {
    const result = await runCli(["connect", "stripe", "--from-env", "MY_STRIPE_KEY", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toContain("MY_STRIPE_KEY");
  });
});

describe("a basic provider", () => {
  it("takes the identifier from --username and the secret from --from-env NAME", async () => {
    process.env.MY_TWILIO_TOKEN = TWILIO_TOKEN;

    const result = await runCli(["connect", "twilio", "--username", TWILIO_SID, "--from-env", "MY_TWILIO_TOKEN", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(json<{ written: string[] }>(result.stdout).written.sort()).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
    expect(result.stdout).not.toContain(TWILIO_TOKEN);
    expect(secretsFile()).toContain(`TWILIO_ACCOUNT_SID=${TWILIO_SID}`);
    expect(secretsFile()).toContain(`TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}`);
  });

  it("takes every field from its own env name with a bare --from-env", async () => {
    process.env.TWILIO_ACCOUNT_SID = TWILIO_SID;
    process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;

    const result = await runCli(["connect", "twilio", "--from-env", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(secretsFile()).toContain(`TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}`);
  });

  it("asks for the identifier visibly and the secret hidden when prompting", async () => {
    const prompts = new ScriptedPrompts({ "twilio.TWILIO_ACCOUNT_SID": TWILIO_SID, "twilio.TWILIO_AUTH_TOKEN": TWILIO_TOKEN });
    setConnectDeps({ prompts });

    const result = await runCli(["connect", "twilio", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(prompts.asked.map((q) => q.id)).toEqual(["twilio.TWILIO_ACCOUNT_SID", "twilio.TWILIO_AUTH_TOKEN"]);
    expect(result.stdout).not.toContain(TWILIO_TOKEN);
  });

  it("names the missing identifier when only the secret is supplied without a terminal", async () => {
    process.env.MY_TWILIO_TOKEN = TWILIO_TOKEN;
    const result = await runCli(["connect", "twilio", "--from-env", "MY_TWILIO_TOKEN", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toContain("--username");
    expect(fs.existsSync(path.join(home, ".env"))).toBe(false);
  });
});

describe("list and remove", () => {
  beforeEach(async () => {
    process.env.MY_STRIPE_KEY = STRIPE_KEY;
    await runCli(["connect", "stripe", "--from-env", "MY_STRIPE_KEY", "--json"]);
  });

  it("lists provider, kind, scopes and expiry and never a value, in both output modes", async () => {
    const machine = await runCli(["connect", "list", "--json"]);
    const human = await runCli(["connect", "list"]);

    expect(machine.exitCode).toBe(EXIT.OK);
    const listing = json<{ providers: { provider: string; kind: string; connected: boolean; scopes: string[]; expiresAt?: string; present: string[] }[] }>(machine.stdout);
    expect(listing.providers.find((p) => p.provider === "stripe")).toMatchObject({ kind: "api_key", connected: true, present: ["STRIPE_SECRET_KEY"] });
    expect(listing.providers.find((p) => p.provider === "google")).toMatchObject({ kind: "oauth2", connected: false, scopes: [] });
    expect(machine.stdout).not.toContain(STRIPE_KEY);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("stripe");
    expect(human.stdout).toContain("api_key");
    expect(human.stdout).not.toContain(STRIPE_KEY);
  });

  it("removes the connection from the secrets file and reports the names it dropped", async () => {
    const result = await runCli(["connect", "remove", "stripe", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(json<{ removed: string[] }>(result.stdout).removed).toEqual(["STRIPE_SECRET_KEY"]);
    expect(secretsFile()).not.toContain(STRIPE_KEY);
    expect(json<{ removed: string[] }>((await runCli(["connect", "remove", "stripe", "--json"])).stdout).removed).toEqual([]);
    expect(json<{ present: boolean }>((await runCli(["config", "get", "STRIPE_SECRET_KEY", "--json"])).stdout).present).toBe(false);
  });
});

describe("an oauth2 provider", () => {
  beforeEach(async () => {
    await runCli(["config", "set", "GOOGLE_CLIENT_ID", CLIENT_ID, "--json"]);
    await runCli(["config", "set", "GOOGLE_CLIENT_SECRET", CLIENT_SECRET, "--json"]);
  });

  it("runs the loopback flow and prints only the provider and the scopes granted", async () => {
    const result = await runCli(["connect", "google", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    const data = json<{ provider: string; kind: string; scopes: string[]; expiresAt: string; hasRefreshToken: boolean; redirectUri: string }>(result.stdout);
    expect(data).toMatchObject({ provider: "google", kind: "oauth2", hasRefreshToken: true });
    expect(data.scopes).toEqual(["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/business.manage"]);
    expect(data.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(server.tokenRequests[0]?.body).toMatchObject({ grant_type: "authorization_code", redirect_uri: data.redirectUri, client_id: CLIENT_ID });
    for (const secret of [...everyIssuedToken(), CLIENT_SECRET]) expect(result.stdout + result.stderr).not.toContain(secret);
    expect(fs.statSync(path.join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(secretsFile()).toContain(`GOOGLE_ACCESS_TOKEN=${server.issued.accessTokens[0]}`);
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).not.toContain(server.issued.accessTokens[0]);

    const human = await runCli(["connect", "list"]);
    expect(human.stdout).toContain("google");
    expect(human.stdout).toContain("business.manage");
    for (const secret of everyIssuedToken()) expect(human.stdout).not.toContain(secret);
  });

  it("refuses a callback with a state it did not send, exits AUTH and stores nothing", async () => {
    server.tamperState = true;

    const result = await runCli(["connect", "google", "--timeout", "5", "--json"]);

    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(result.stdout).toMatch(/state/i);
    expect(server.tokenRequests).toHaveLength(0);
    expect(secretsFile()).not.toContain("GOOGLE_ACCESS_TOKEN");
  });

  it("refreshes on demand, reporting the new expiry and never the token", async () => {
    await runCli(["connect", "google", "--json"]);
    const before = secretsFile();

    const result = await runCli(["connect", "refresh", "google", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(server.refreshCount).toBe(1);
    expect(json<{ provider: string; hasRefreshToken: boolean; expiresAt: string }>(result.stdout)).toMatchObject({ provider: "google", hasRefreshToken: true });
    expect(secretsFile()).not.toBe(before);
    for (const secret of everyIssuedToken()) expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it("prints the authorization URL instead of opening a browser with --no-browser", async () => {
    const opened: string[] = [];
    setConnectDeps({ endpoints: { google: server.endpoints }, openBrowser: (url) => void opened.push(url), interactive: false });

    const result = await runCli(["connect", "google", "--no-browser", "--timeout", "1", "--json"]);

    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(opened).toEqual([]);
    expect(result.stderr).toContain(`${server.endpoints.authorization}?`);
    expect(result.stderr).not.toContain(CLIENT_SECRET);
  });

  it("refuses to start without the registered app, naming the env name to set, with exit CONFIG", async () => {
    await runCli(["config", "unset", "GOOGLE_CLIENT_ID", "--json"]);
    const result = await runCli(["connect", "google", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("GOOGLE_CLIENT_ID");
    expect(server.authorizeRequests).toHaveLength(0);
  });

  it("refuses to refresh a provider that has no OAuth flow", async () => {
    const result = await runCli(["connect", "refresh", "stripe", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
  });
});

describe("the security audit after a connect", () => {
  it("sees the tokens as secrets in the 0600 file and finds no credential in config.yaml", async () => {
    process.env.MY_STRIPE_KEY = STRIPE_KEY;
    await runCli(["connect", "stripe", "--from-env", "MY_STRIPE_KEY", "--json"]);
    await runCli(["config", "set", "GOOGLE_CLIENT_ID", CLIENT_ID, "--json"]);
    await runCli(["config", "set", "GOOGLE_CLIENT_SECRET", CLIENT_SECRET, "--json"]);
    await runCli(["connect", "google", "--json"]);

    const audit = await runCli(["security", "audit", home, "--json"]);

    const report = json<{ findings: { id: string; message: string }[]; sections: { id: string; details: Record<string, unknown> }[] }>(audit.stdout);
    // The credential scan of config.yaml finds nothing: the tokens are not there.
    expect(report.findings.map((f) => f.id)).not.toContain("secret-in-config-yaml");
    expect(report.sections.find((s) => s.id === "config-secrets")?.details.keys).toEqual([]);
    // The permissions walk saw the secrets file and had nothing to say about it. (It may still
    // flag `sessions/`, which `ConfigManager.ensureDirs` creates at 0755 on any secret write; that
    // is a pre-existing defect of the config layer, not of this flow, and is not absorbed here.)
    const permissions = report.sections.find((s) => s.id === "file-permissions");
    expect(permissions?.details.checked as number).toBeGreaterThanOrEqual(1);
    const problems = permissions?.details.problems as { path: string }[];
    expect(problems.map((p) => p.path)).not.toContain(".env");
    expect(report.findings.filter((f) => f.message.includes(".env"))).toEqual([]);
    for (const secret of [...everyIssuedToken(), STRIPE_KEY, CLIENT_SECRET]) expect(audit.stdout).not.toContain(secret);
  });
});
