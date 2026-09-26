/**
 * [C10] Whether the daemon a unit starts keeps its store. The unit runs this process's own runtime
 * (`./program.ts`), so the answer is known at install time, by the rule `../store/durability.ts`
 * states: under Node there is no `bun:sqlite`, so the store is in process memory; under Bun (the
 * compiled binary, or Bun running the source) it is the SQLite store.
 */
import { describe, expect, it } from "vitest";
import { explainStoreFailure } from "../store/durability.js";
import { EPHEMERAL_SERVICE_REFUSAL, ephemeralStoreLine, serviceDurability, serviceDurabilityLine } from "./durability.js";

describe("serviceDurability", () => {
  it("under Node it is not durable, for the store's own reason", () => {
    expect(serviceDurability({})).toEqual({ durable: false, reason: explainStoreFailure(undefined, false).reason });
    expect(serviceDurability({ bunVersion: undefined })).toMatchObject({ durable: false });
  });

  it("under Bun (the binary, or bun running the source) it is durable", () => {
    expect(serviceDurability({ bunVersion: "1.4.2" })).toEqual({ durable: true });
  });
});

describe("the words", () => {
  it("the install refusal is the one line the council fixed", () => {
    expect(EPHEMERAL_SERVICE_REFUSAL).toBe("This service would forget its runs, approvals and audit on every restart (Node has no durable store); run it from the binary or Bun, or pass --allow-ephemeral");
  });

  it("install's plain line says durable, or not durable and why", () => {
    expect(serviceDurabilityLine({ durable: true })).toBe("durable: runs, approvals and audit survive a restart");
    expect(serviceDurabilityLine({ durable: false, reason: "the SQLite store needs Bun" })).toBe("not durable: the SQLite store needs Bun; runs, approvals and audit are lost at every restart");
  });

  it("the daemon's start line is named service.ephemeral_store and carries the reason", () => {
    expect(ephemeralStoreLine({ cause: "needs_bun", reason: "the SQLite store needs Bun" })).toBe(
      "service.ephemeral_store: not durable: the SQLite store needs Bun; runs, approvals and audit are lost when this process exits",
    );
  });
});
