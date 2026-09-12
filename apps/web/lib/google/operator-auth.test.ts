import { afterEach, describe, expect, it } from "vitest";
import { isOperator } from "@/lib/google/operator-auth";

const SAVED = { db: process.env.DATABASE_URL, ops: process.env.OPERATOR_EMAILS };

afterEach(() => {
  if (SAVED.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = SAVED.db;
  if (SAVED.ops === undefined) delete process.env.OPERATOR_EMAILS; else process.env.OPERATOR_EMAILS = SAVED.ops;
});

describe("isOperator", () => {
  it("allows an email listed in OPERATOR_EMAILS (case-insensitive)", () => {
    process.env.OPERATOR_EMAILS = "boss@trent.app, owner@trent.app";
    expect(isOperator("OWNER@trent.app")).toBe(true);
  });

  it("denies an email not in OPERATOR_EMAILS even in dev", () => {
    delete process.env.DATABASE_URL;
    process.env.OPERATOR_EMAILS = "boss@trent.app";
    expect(isOperator("stranger@evil.com")).toBe(false);
  });

  it("fails closed in production when OPERATOR_EMAILS is unset", () => {
    process.env.DATABASE_URL = "postgres://prod";
    delete process.env.OPERATOR_EMAILS;
    expect(isOperator("anyone@trent.app")).toBe(false);
  });

  it("allows any signed-in user in dev when nothing is configured", () => {
    delete process.env.DATABASE_URL;
    delete process.env.OPERATOR_EMAILS;
    expect(isOperator("dev@localhost")).toBe(true);
  });
});
