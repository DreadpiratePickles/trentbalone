/**
 * Which host(s) the configured provider's key belongs to, for binding the REPL's broker token.
 * The endpoint table is `doctor/endpoint.ts` `providerEndpoint` (the mirror of what the runtime's
 * clients read); this only turns its URL into the binding the broker matches on.
 */
import { describe, expect, it } from "vitest";
import { credentialHostsForProvider } from "./provider-hosts.js";

describe("credentialHostsForProvider", () => {
  it("binds each hosted provider's key to the host its model calls go to", () => {
    expect(credentialHostsForProvider("openai", {})).toEqual(["api.openai.com"]);
    expect(credentialHostsForProvider("anthropic", {})).toEqual(["api.anthropic.com"]);
    expect(credentialHostsForProvider("google", {})).toEqual(["generativelanguage.googleapis.com"]);
    expect(credentialHostsForProvider("mistral", {})).toEqual(["api.mistral.ai"]);
    expect(credentialHostsForProvider("openrouter", {})).toEqual(["openrouter.ai"]);
  });

  it("follows an OpenAI-compatible base URL the operator moved, keeping an explicit port", () => {
    expect(credentialHostsForProvider("openai", { OPENAI_BASE_URL: "https://llm-gateway.corp.example/v1" })).toEqual(["llm-gateway.corp.example"]);
    expect(credentialHostsForProvider("openai", { OPENAI_BASE_URL: "http://127.0.0.1:8000/v1" })).toEqual(["127.0.0.1:8000"]);
    expect(credentialHostsForProvider("google", { GOOGLE_BASE_URL: "https://gemini-proxy.corp.example:8443/v1beta/openai/" })).toEqual(["gemini-proxy.corp.example:8443"]);
  });

  it("binds an alias to its own endpoint: a local runtime on loopback with its port, a hosted one by host", () => {
    expect(credentialHostsForProvider("ollama", {})).toEqual(["127.0.0.1:11434"]);
    expect(credentialHostsForProvider("lmstudio", {})).toEqual(["127.0.0.1:1234"]);
    expect(credentialHostsForProvider("deepseek", {})).toEqual(["api.deepseek.com"]);
    expect(credentialHostsForProvider("groq", {})).toEqual(["api.groq.com"]);
    expect(credentialHostsForProvider("ollama", { OLLAMA_BASE_URL: "http://gpu-box.lan:11434/v1" })).toEqual(["gpu-box.lan:11434"]);
  });

  it("binds nothing (so the broker injects nothing) for no provider, an unknown one, or an unparseable base URL", () => {
    expect(credentialHostsForProvider(undefined, {})).toEqual([]);
    expect(credentialHostsForProvider("not-a-provider", {})).toEqual([]);
    expect(credentialHostsForProvider("openai", { OPENAI_BASE_URL: "not a url" })).toEqual([]);
  });
});
