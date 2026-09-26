/**
 * P2-9 RED — the A2A client: discover a peer's Agent Card and send it a message in the dialect
 * the card advertises.
 *
 * Two kinds of peer. A scripted fake (`tools/a2a/testing/fake-peer.ts`) serves a v1.0-only, a
 * 0.3.0-only or a dual card and refuses the other dialect's method, so each test proves which
 * dialect the client chose. And Trent's OWN server (`A2AServer` over a fake runner, no model)
 * serves the dual card, so the client is proven against the server it has to interoperate with.
 *
 * The shapes are the specification's (spec.ts, v1.ts) and Hermes v0.21.3's wire
 * (docs/sessions/2026-09-20-a2a-v1-wire.md): v1.0 is `SendMessage` with `ROLE_USER` and parts
 * `{text, mediaType}` with no `kind`, under `A2A-Version: 1.0`; 0.3.0 is `message/send` with
 * `kind: "message"`, role `user` and parts `{kind: "text", text}`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner, AgentRunInput } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { FakePeer, type FakePeerOptions } from "../tools/a2a/testing/fake-peer.js";
import { A2AServer } from "./A2AServer.js";
import { A2AClientError, fetchAgentCard, parseAgentCard, sendA2AMessage } from "./client.js";

const open: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of open.splice(0)) await server.stop();
});

async function peer(options: FakePeerOptions = {}): Promise<FakePeer> {
  const fake = new FakePeer(options);
  await fake.start();
  open.push(fake);
  return fake;
}

const fetchImpl = globalThis.fetch;

describe("fetchAgentCard", () => {
  it("reads a v1.0-only card: the JSONRPC interface is the endpoint and the dialect is 1.0", async () => {
    const fake = await peer({ card: "v1", name: "Hermes" });
    const card = await fetchAgentCard(fake.url, { fetchImpl });
    expect(card.name).toBe("Hermes");
    expect(card.dialect).toBe("1.0");
    expect(card.endpoint).toBe(`${fake.url}/`);
    expect(card.cardUrl).toBe(`${fake.url}/.well-known/agent-card.json`);
    expect(card.skills).toEqual([{ id: "triage", name: "Triage", description: "Sorts an incident into a queue.", tags: ["support"] }]);
    expect(card.requiresAuth).toBe(false);
  });

  it("reads a 0.3.0-only card: the top-level url is the endpoint and the dialect is 0.3.0", async () => {
    const fake = await peer({ card: "0.3" });
    const card = await fetchAgentCard(`${fake.url}/`, { fetchImpl });
    expect(card.dialect).toBe("0.3.0");
    expect(card.endpoint).toBe(`${fake.url}/`);
    expect(card.interfaces).toEqual([{ dialect: "0.3.0", url: `${fake.url}/` }]);
  });

  it("prefers v1.0 when a card advertises both, and says it requires a bearer when `security` is declared", async () => {
    const fake = await peer({ card: "both", token: "t" });
    const card = await fetchAgentCard(fake.url, { fetchImpl });
    expect(card.dialect).toBe("1.0");
    expect(card.interfaces.map((entry) => entry.dialect).sort()).toEqual(["0.3.0", "1.0"]);
    expect(card.requiresAuth).toBe(true);
  });

  it("falls back to the pre-0.3 well-known path when the current one is absent", async () => {
    const fake = await peer({ card: "0.3", legacyCardOnly: true });
    const card = await fetchAgentCard(fake.url, { fetchImpl });
    expect(card.cardUrl).toBe(`${fake.url}/.well-known/agent.json`);
    expect(fake.requests.map((request) => request.path)).toEqual(["/.well-known/agent-card.json", "/.well-known/agent.json"]);
  });

  it("refuses a card with no name, or with no JSON-RPC endpoint in either dialect, as a card error", () => {
    expect(() => parseAgentCard({ description: "x", url: "http://127.0.0.1:1/" }, "http://127.0.0.1:1/.well-known/agent-card.json")).toThrow(A2AClientError);
    try {
      parseAgentCard({ name: "grpc only", description: "x", supportedInterfaces: [{ url: "http://127.0.0.1:1/", protocolBinding: "GRPC", protocolVersion: "1.0" }] }, "http://127.0.0.1:1/c");
      expect.unreachable("a card with no JSONRPC endpoint must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(A2AClientError);
      expect((error as A2AClientError).kind).toBe("card");
      expect((error as Error).message).toMatch(/JSON-RPC endpoint/);
    }
  });
});

describe("sendA2AMessage", () => {
  it("speaks v1.0 to a v1.0 card: SendMessage, ROLE_USER, parts {text, mediaType} with no kind, the version header and the bearer", async () => {
    const fake = await peer({ card: "v1" });
    const card = await fetchAgentCard(fake.url, { fetchImpl });
    const reply = await sendA2AMessage({ endpoint: card.endpoint, dialect: card.dialect, text: "triage the checkout outage" }, { fetchImpl, token: "peer-token" });

    const [call] = fake.rpc();
    const body = call!.body as { jsonrpc: string; method: string; params: { message: Record<string, unknown> } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("SendMessage");
    expect(body.params.message.role).toBe("ROLE_USER");
    expect(body.params.message.parts).toEqual([{ text: "triage the checkout outage", mediaType: "text/plain" }]);
    expect(body.params.message).not.toHaveProperty("kind");
    expect(typeof body.params.message.messageId).toBe("string");
    expect(call!.headers["a2a-version"]).toBe("1.0");
    expect(call!.headers.authorization).toBe("Bearer peer-token");

    expect(reply).toEqual({ taskId: "task-1", contextId: "ctx-1", state: "completed", text: "echo: triage the checkout outage" });
  });

  it("speaks 0.3.0 to a 0.3.0 card: message/send, kind message, role user, parts {kind: text}, and no version header", async () => {
    const fake = await peer({ card: "0.3" });
    const card = await fetchAgentCard(fake.url, { fetchImpl });
    const reply = await sendA2AMessage({ endpoint: card.endpoint, dialect: card.dialect, text: "summarise the incident" }, { fetchImpl });

    const [call] = fake.rpc();
    const body = call!.body as { method: string; params: { message: Record<string, unknown> } };
    expect(body.method).toBe("message/send");
    expect(body.params.message.kind).toBe("message");
    expect(body.params.message.role).toBe("user");
    expect(body.params.message.parts).toEqual([{ kind: "text", text: "summarise the incident" }]);
    expect(call!.headers["a2a-version"]).toBeUndefined();
    expect(call!.headers.authorization).toBeUndefined();
    expect(reply).toEqual({ taskId: "task-1", contextId: "ctx-1", state: "completed", text: "echo: summarise the incident" });
  });

  it("returns the question and both ids when the task ends input-required, and continues that task when given them", async () => {
    for (const shape of ["v1", "0.3"] as const) {
      const fake = await peer({ card: shape, answer: (turn) => (turn.index === 1 ? { state: "input-required", text: "which environment?" } : { state: "completed", text: `deploying to ${turn.text}` }) });
      const card = await fetchAgentCard(fake.url, { fetchImpl });
      const first = await sendA2AMessage({ endpoint: card.endpoint, dialect: card.dialect, text: "deploy the release" }, { fetchImpl });
      expect(first).toEqual({ taskId: "task-1", contextId: "ctx-1", state: "input-required", text: "which environment?", question: "which environment?" });

      const second = await sendA2AMessage({ endpoint: card.endpoint, dialect: card.dialect, text: "staging", taskId: first.taskId, contextId: first.contextId }, { fetchImpl });
      const sent = (fake.rpc()[1]!.body as { params: { message: Record<string, unknown> } }).params.message;
      expect(sent.taskId, shape).toBe("task-1");
      expect(sent.contextId, shape).toBe("ctx-1");
      expect(second, shape).toEqual({ taskId: "task-1", contextId: "ctx-1", state: "completed", text: "deploying to staging" });
    }
  });

  it("raises the peer's JSON-RPC error as an rpc error with its code, and a refused bearer as an http error", async () => {
    const v1 = await peer({ card: "v1" });
    try {
      await sendA2AMessage({ endpoint: `${v1.url}/`, dialect: "0.3.0", text: "wrong dialect" }, { fetchImpl });
      expect.unreachable("a JSON-RPC error must throw");
    } catch (error) {
      expect((error as A2AClientError).kind).toBe("rpc");
      expect((error as A2AClientError).rpcCode).toBe(-32601);
    }
    const locked = await peer({ card: "v1", token: "right" });
    try {
      await sendA2AMessage({ endpoint: `${locked.url}/`, dialect: "1.0", text: "hi" }, { fetchImpl, token: "wrong" });
      expect.unreachable("a 401 must throw");
    } catch (error) {
      expect((error as A2AClientError).kind).toBe("http");
      expect((error as A2AClientError).status).toBe(401);
      expect((error as Error).message).not.toContain("wrong");
    }
  });
});

describe("against Trent's own A2A server (fake runner, no model)", () => {
  const DONE: OrcEvent[] = [
    { kind: "run_start", runId: "run_client", at: "2026-09-25T00:00:00.000Z" } as OrcEvent,
    { kind: "run_done", runId: "run_client", at: "2026-09-25T00:00:00.000Z", run: { status: "completed", summary: "the queue is healthy" } } as unknown as OrcEvent,
  ];
  function runner(): AgentRunner & { objectives: string[] } {
    const objectives: string[] = [];
    return {
      objectives,
      run(input: AgentRunInput) {
        objectives.push(input.objective);
        return (async function* () {
          for (const event of DONE) yield event;
        })();
      },
    };
  }

  it("discovers v1.0 from the dual card and completes a task in each dialect", async () => {
    const fake = runner();
    const server = new A2AServer({ port: 0, runner: fake });
    await server.start();
    open.push(server);
    const origin = `http://127.0.0.1:${server.getPort()}`;
    const card = await fetchAgentCard(origin, { fetchImpl });
    expect(card.name).toBe("Trent Fleet");
    expect(card.dialect).toBe("1.0");
    expect(card.skills.length).toBe(9);
    for (const dialect of ["1.0", "0.3.0"] as const) {
      const reply = await sendA2AMessage({ endpoint: card.endpoint, dialect, text: `check the queue (${dialect})` }, { fetchImpl });
      expect(reply.state, dialect).toBe("completed");
      expect(reply.text, dialect).toBe("the queue is healthy");
      expect(reply.taskId, dialect).toMatch(/^task-/);
    }
    expect(fake.objectives).toEqual(["check the queue (1.0)", "check the queue (0.3.0)"]);
  });
});
