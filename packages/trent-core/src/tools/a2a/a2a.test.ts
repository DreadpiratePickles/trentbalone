/**
 * P2-9 RED — the `a2a` toolset through the real wrapper chain, over fake peers.
 *
 *   a2a_list      the configured peers and their cached cards; reads nothing off the machine
 *   a2a_discover  fetches and validates one peer's card (v1.0 or 0.3.0) and caches it
 *   a2a_send      one message to a peer, in the dialect its card advertises: floored, previewed,
 *                 bound to exactly that peer and text, keyed, and its reply tagged untrusted
 *   a2a_history   the tasks THIS profile started with a peer, from the profile's own store
 *
 * A URL is reachable only when its origin is a configured peer's; anything else is refused before
 * a socket opens. The peer's bearer is read by the NAME the peer entry gives (`token_env`) from the
 * profile's own secrets file and never appears in a summary, a preview or the history file.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakePeer, type FakePeerOptions } from "./testing/fake-peer.js";
import { action, approvedCall, buildA2aHarness, inStep, type A2aHarness, type HarnessPeer } from "./testing/harness.js";

const TOKEN_NAME = "HERMES_A2A_TOKEN";
const TOKEN_VALUE = "peer-token-for-tests-only";

const peers: FakePeer[] = [];
let harness: A2aHarness | undefined;

afterEach(async () => {
  harness?.cleanup();
  harness = undefined;
  for (const fake of peers.splice(0)) await fake.stop();
});

async function fakePeer(options: FakePeerOptions = {}): Promise<FakePeer> {
  const fake = new FakePeer(options);
  await fake.start();
  peers.push(fake);
  return fake;
}

function build(entries: readonly HarnessPeer[], secrets: Record<string, string> = { [TOKEN_NAME]: TOKEN_VALUE }): A2aHarness {
  harness = buildA2aHarness({ peers: entries, secrets });
  return harness;
}

/** Everything the toolset wrote under the profile, as one string, to prove no value leaked into it. */
function profileFiles(profileDir: string): string {
  const dir = path.join(profileDir, "a2a");
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
}

describe("a2a_list and a2a_discover", () => {
  it("lists the configured peers by name, url and token NAME before anything is discovered, and reaches no peer", async () => {
    const hermes = await fakePeer({ card: "v1", name: "Hermes" });
    const { adapter } = build([{ name: "hermes", url: hermes.url, token_env: TOKEN_NAME }, { name: "quiet", url: "http://127.0.0.1:9/" }]);
    const listed = await adapter.execute(action("a2a_list", {}), {});
    expect(listed.status).toBe("completed");
    expect(listed.summary).toContain("hermes");
    expect(listed.summary).toContain(hermes.url);
    expect(listed.summary).toContain(TOKEN_NAME);
    expect(listed.summary).toContain("quiet");
    expect(listed.summary).toMatch(/not discovered/);
    expect(listed.summary).not.toContain(TOKEN_VALUE);
    expect(hermes.requests).toHaveLength(0);
    expect(adapter.requiresApproval(action("a2a_list", {}))).toBe(false);
  });

  it("discovers a v1.0 peer by name and a 0.3.0 peer by url, caches both cards, and tags what the peers wrote untrusted", async () => {
    const hermes = await fakePeer({ card: "v1", name: "Hermes" });
    const legacy = await fakePeer({ card: "0.3", name: "Legacy Agent" });
    const { adapter } = build([{ name: "hermes", url: hermes.url, token_env: TOKEN_NAME }, { name: "legacy", url: legacy.url }]);

    const v1 = await adapter.execute(action("a2a_discover", { peer: "hermes" }), {});
    expect(v1.status).toBe("completed");
    expect(v1.summary).toContain("Hermes");
    expect(v1.summary).toContain("1.0");
    expect(v1.summary).toContain("triage");
    expect(v1.provenance).toBe("untrusted");

    const v03 = await adapter.execute(action("a2a_discover", { url: `${legacy.url}/` }), {});
    expect(v03.status).toBe("completed");
    expect(v03.summary).toContain("Legacy Agent");
    expect(v03.summary).toContain("0.3.0");
    expect(v03.provenance).toBe("untrusted");

    const listed = await adapter.execute(action("a2a_list", {}), {});
    expect(listed.summary).toContain("Hermes");
    expect(listed.summary).toContain("Legacy Agent");
    expect(listed.summary).not.toMatch(/not discovered/);
    expect(adapter.requiresApproval(action("a2a_discover", { peer: "hermes" }))).toBe(false);
  });

  it("refuses a url whose origin is not a configured peer, before any request leaves", async () => {
    const hermes = await fakePeer({ card: "v1" });
    const stranger = await fakePeer({ card: "v1" });
    const { adapter } = build([{ name: "hermes", url: hermes.url }]);
    for (const url of [stranger.url, "http://169.254.169.254/latest/meta-data", "https://evil.example.test/"]) {
      const refused = await adapter.execute(action("a2a_discover", { url }), {});
      expect(refused.status, url).toBe("failed");
      expect(refused.summary, url).toMatch(/not a configured peer/);
      expect(refused.summary, url).toMatch(/a2a\.peers/);
    }
    const unknown = await adapter.execute(action("a2a_discover", { peer: "nobody" }), {});
    expect(unknown.status).toBe("failed");
    expect(unknown.summary).toMatch(/no peer named "nobody"/);
    expect(stranger.requests).toHaveLength(0);
    expect(hermes.requests).toHaveLength(0);
  });
});

describe("a2a_send", () => {
  it("asks first, previews the peer and the exact message, sends once with the bearer read by name, and tags the reply untrusted", async () => {
    const hermes = await fakePeer({ card: "v1", name: "Hermes", token: TOKEN_VALUE });
    const { adapter, profileDir } = build([{ name: "hermes", url: hermes.url, token_env: TOKEN_NAME }]);
    const line = action("a2a_send", { peer: "hermes", message: "triage the checkout outage" });
    expect(adapter.requiresApproval(line)).toBe(true);
    const preview = adapter.preview!(line)!;
    expect(preview).toContain("hermes");
    expect(preview).toContain(hermes.url);
    expect(preview).toContain("triage the checkout outage");
    expect(preview).not.toContain(TOKEN_VALUE);

    const { parked, shown, done } = await approvedCall(adapter, "run_1", "step_1", line);
    expect(parked.status).toBe("needs_approval");
    expect(shown.status).toBe("needs_approval");
    expect(shown.summary).toContain("triage the checkout outage");
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("echo: triage the checkout outage");
    expect(done.summary).toContain("task-1");
    expect(done.summary).toContain("ctx-1");
    expect(done.summary).toContain("completed");
    expect(done.summary).toMatch(/untrusted/);
    expect(done.provenance).toBe("untrusted");

    const sends = hermes.rpc();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.headers.authorization).toBe(`Bearer ${TOKEN_VALUE}`);
    expect((sends[0]!.body as { method: string }).method).toBe("SendMessage");

    // A replay inside the same step is answered from the idempotency store: still one send.
    const again = await inStep("run_1", "step_1", () => adapter.execute(line, {}));
    expect(again.summary).toBe(done.summary);
    expect(hermes.rpc()).toHaveLength(1);
    for (const record of [parked, shown, done]) expect(record.summary).not.toContain(TOKEN_VALUE);
    expect(profileFiles(profileDir)).not.toContain(TOKEN_VALUE);
  });

  it("speaks 0.3.0 to a 0.3.0 peer", async () => {
    const legacy = await fakePeer({ card: "0.3" });
    const { adapter } = build([{ name: "legacy", url: legacy.url }]);
    const { done } = await approvedCall(adapter, "run_2", "step_1", action("a2a_send", { url: legacy.url, message: "summarise the incident" }));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("echo: summarise the incident");
    expect((legacy.rpc()[0]!.body as { method: string }).method).toBe("message/send");
  });

  it("returns the question and the ids to continue with on input-required, and continues that task", async () => {
    const hermes = await fakePeer({ card: "v1", answer: (turn) => (turn.index === 1 ? { state: "input-required", text: "which environment?" } : { state: "completed", text: `deploying to ${turn.text}` }) });
    const { adapter } = build([{ name: "hermes", url: hermes.url }]);
    const { done: first } = await approvedCall(adapter, "run_3", "step_1", action("a2a_send", { peer: "hermes", message: "deploy the release" }));
    expect(first.status).toBe("completed");
    expect(first.summary).toContain("input-required");
    expect(first.summary).toContain("which environment?");
    expect(first.summary).toContain('"task_id":"task-1"');
    expect(first.summary).toContain('"context_id":"ctx-1"');

    const { done: second } = await approvedCall(adapter, "run_3", "step_2", action("a2a_send", { peer: "hermes", message: "staging", task_id: "task-1", context_id: "ctx-1" }));
    expect(second.status).toBe("completed");
    expect(second.summary).toContain("deploying to staging");
    const sent = (hermes.rpc()[1]!.body as { params: { message: Record<string, unknown> } }).params.message;
    expect(sent.taskId).toBe("task-1");
    expect(sent.contextId).toBe("ctx-1");
  });

  it("refuses a url that is not a configured peer even when approved, and names the missing token by name without sending", async () => {
    const hermes = await fakePeer({ card: "v1" });
    const stranger = await fakePeer({ card: "v1" });
    const { adapter } = build([{ name: "hermes", url: hermes.url, token_env: "UNSET_A2A_TOKEN" }], {});

    const line = action("a2a_send", { url: stranger.url, message: "hello" });
    expect(adapter.preview!(line)).toMatch(/cannot run: .*not a configured peer/);
    const { done: refused } = await approvedCall(adapter, "run_4", "step_1", line);
    expect(refused.status).toBe("failed");
    expect(refused.summary).toMatch(/not a configured peer/);
    expect(stranger.requests).toHaveLength(0);

    const { done: noToken } = await approvedCall(adapter, "run_4", "step_2", action("a2a_send", { peer: "hermes", message: "hello" }));
    expect(noToken.status).toBe("failed");
    expect(noToken.summary).toContain("UNSET_A2A_TOKEN");
    expect(noToken.summary).toMatch(/trent config set UNSET_A2A_TOKEN/);
    expect(hermes.rpc()).toHaveLength(0);
  });
});

describe("a2a_history", () => {
  it("lists the tasks this profile started with one peer, newest last, filtered by context, and reads no peer", async () => {
    const hermes = await fakePeer({ card: "v1" });
    const other = await fakePeer({ card: "0.3" });
    const { adapter, profileDir } = build([{ name: "hermes", url: hermes.url }, { name: "other", url: other.url }]);
    await approvedCall(adapter, "run_5", "step_1", action("a2a_send", { peer: "hermes", message: "first question" }));
    await approvedCall(adapter, "run_5", "step_2", action("a2a_send", { peer: "hermes", message: "second question" }));
    await approvedCall(adapter, "run_5", "step_3", action("a2a_send", { peer: "other", message: "elsewhere" }));
    const before = hermes.requests.length;

    const history = await adapter.execute(action("a2a_history", { peer: "hermes" }), {});
    expect(history.status).toBe("completed");
    expect(history.summary).toContain("task-1");
    expect(history.summary).toContain("task-2");
    expect(history.summary.indexOf("first question")).toBeLessThan(history.summary.indexOf("second question"));
    expect(history.summary).not.toContain("elsewhere");
    expect(history.provenance).toBe("untrusted");

    const one = await adapter.execute(action("a2a_history", { peer: "hermes", context_id: "ctx-2" }), {});
    expect(one.summary).toContain("second question");
    expect(one.summary).not.toContain("first question");
    expect(hermes.requests.length).toBe(before);
    expect(adapter.requiresApproval(action("a2a_history", { peer: "hermes" }))).toBe(false);

    const store = fs.statSync(path.join(profileDir, "a2a", "history.json"));
    expect(store.mode & 0o777).toBe(0o600);
  });
});
