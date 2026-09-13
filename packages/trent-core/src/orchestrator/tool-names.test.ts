import { describe, expect, it } from "vitest";

import { normaliseSeatTurn, resolveToolName } from "./tool-names.js";

/** The exact list the ceo seat was advertised in the live proof (§2.2). */
const REGISTERED = [
  "memory:read",
  "tasks:create",
  "reports:create",
  "approvals:request",
  "Email",
  "Stripe",
  "steel:scrape",
  "steel:screenshot",
  "steel:pdf",
  "steel:sessions",
  "vault:read",
  "vault:write",
  "vault:graph",
  "gitnexus:search",
  "gitnexus:context",
];

describe("resolveToolName", () => {
  it("leaves an exact registered name alone", () => {
    expect(resolveToolName({ name: "memory:read", action: "count" }, REGISTERED)).toEqual({ kind: "exact", name: "memory:read" });
    expect(resolveToolName({ name: "email", action: "draft" }, REGISTERED)).toEqual({ kind: "exact", name: "Email" });
  });

  it("maps the live-proof miss {name:'memory', action:'read'} onto memory:read", () => {
    expect(resolveToolName({ name: "memory", action: "read" }, REGISTERED)).toEqual({
      kind: "normalised",
      name: "memory:read",
      action: "read",
      from: "memory",
    });
  });

  it("keeps the rest of the action when the verb is only its first word", () => {
    expect(resolveToolName({ name: "memory", action: "read count memory documents" }, REGISTERED)).toMatchObject({
      kind: "normalised",
      name: "memory:read",
      action: "count memory documents",
    });
  });

  it("accepts dotted and slashed spellings", () => {
    expect(resolveToolName({ name: "steel.scrape", action: "x" }, REGISTERED)).toMatchObject({ kind: "normalised", name: "steel:scrape" });
    expect(resolveToolName({ name: "gitnexus/search", action: "x" }, REGISTERED)).toMatchObject({ kind: "normalised", name: "gitnexus:search" });
  });

  it("maps a bare prefix when exactly one adapter carries it", () => {
    expect(resolveToolName({ name: "tasks", action: "add a task" }, REGISTERED)).toMatchObject({ kind: "normalised", name: "tasks:create", action: "add a task" });
  });

  it("refuses when the prefix is ambiguous", () => {
    expect(resolveToolName({ name: "vault", action: "the graph please" }, REGISTERED)).toEqual({
      kind: "ambiguous",
      candidates: ["vault:read", "vault:write", "vault:graph"],
    });
    expect(resolveToolName({ name: "steel", action: "" }, REGISTERED).kind).toBe("ambiguous");
  });

  it("resolves an ambiguous prefix once the action names the verb", () => {
    expect(resolveToolName({ name: "vault", action: "graph the notes" }, REGISTERED)).toMatchObject({ kind: "normalised", name: "vault:graph", action: "the notes" });
  });

  it("reports unknown for names nothing resembles, and for non-strings", () => {
    expect(resolveToolName({ name: "filesystem", action: "read" }, REGISTERED)).toEqual({ kind: "unknown" });
    expect(resolveToolName({ name: 42, action: "read" }, REGISTERED)).toEqual({ kind: "unknown" });
    expect(resolveToolName({ name: "   " }, REGISTERED)).toEqual({ kind: "unknown" });
  });
});

describe("normaliseSeatTurn", () => {
  it("rewrites a normalisable tool call without mutating the original turn", () => {
    const turn = { toolCall: { name: "memory", action: "read" }, summary: null };
    const out = normaliseSeatTurn(turn, REGISTERED);
    expect(out).toEqual({ toolCall: { name: "memory:read", action: "read" }, summary: null });
    expect(turn.toolCall.name).toBe("memory");
  });

  it("returns the same object for exact, ambiguous, unknown and non-tool turns", () => {
    const exact = { toolCall: { name: "memory:read", action: "x" } };
    const ambiguous = { toolCall: { name: "vault", action: "" } };
    const final = { toolCall: null, summary: "done" };
    expect(normaliseSeatTurn(exact, REGISTERED)).toBe(exact);
    expect(normaliseSeatTurn(ambiguous, REGISTERED)).toBe(ambiguous);
    expect(normaliseSeatTurn(final, REGISTERED)).toBe(final);
    expect(normaliseSeatTurn(null, REGISTERED)).toBeNull();
  });
});
