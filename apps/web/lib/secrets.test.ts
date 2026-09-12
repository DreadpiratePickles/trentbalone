import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptJson, decryptJson, rekeySecret, maskSecret } from "./secrets";

describe("encryptJson / decryptJson", () => {
  it("round-trips a plain string", () => {
    const ct = encryptJson("hello");
    expect(decryptJson<string>(ct)).toBe("hello");
  });

  it("round-trips an object", () => {
    const val = { apiKey: "sk-test", port: 443, nested: { ok: true } };
    const ct = encryptJson(val);
    expect(decryptJson(ct)).toEqual(val);
  });

  it("produces a v1: prefixed ciphertext", () => {
    expect(encryptJson("x")).toMatch(/^v1:/);
  });

  it("produces different ciphertext each call (random IV)", () => {
    const a = encryptJson("same");
    const b = encryptJson("same");
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext (GCM auth tag mismatch)", () => {
    const ct = encryptJson("sensitive");
    const parts = ct.split(":");
    parts[3] = Buffer.from("deadbeef".repeat(8), "hex").toString("base64");
    expect(() => decryptJson(parts.join(":"))).toThrow();
  });

  it("throws on unsupported version prefix", () => {
    expect(() => decryptJson("v9:aaa:bbb:ccc")).toThrow(/Unsupported secret version/);
  });

  it("throws on malformed v1 payload (missing segments)", () => {
    expect(() => decryptJson("v1:onlyone")).toThrow(/Malformed/);
  });
});

describe("rekeySecret", () => {
  const OLD_KEY = "old-local-key-for-testing";
  const NEW_KEY = "new-local-key-for-testing";

  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = OLD_KEY;
  });

  afterEach(() => {
    process.env.SECRET_ENCRYPTION_KEY = savedKey;
  });

  it("decrypts with old key then re-encrypts with new key", () => {
    const original = { token: "abc123" };
    const ct = encryptJson(original);

    const rekeyed = rekeySecret(ct, OLD_KEY, NEW_KEY);

    process.env.SECRET_ENCRYPTION_KEY = NEW_KEY;
    expect(decryptJson(rekeyed)).toEqual(original);
  });

  it("old ciphertext cannot be decrypted after rekeying to new key", () => {
    const ct = encryptJson("secret");
    rekeySecret(ct, OLD_KEY, NEW_KEY);

    process.env.SECRET_ENCRYPTION_KEY = NEW_KEY;
    // Original ciphertext was encrypted with OLD_KEY — must fail under NEW_KEY
    expect(() => decryptJson(ct)).toThrow();
  });

  it("throws when ciphertext was not encrypted with the provided old key", () => {
    const ct = encryptJson("data");
    expect(() => rekeySecret(ct, "wrong-old-key", NEW_KEY)).toThrow();
  });
});

describe("maskSecret", () => {
  it("returns undefined for undefined input", () => {
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it("masks short values fully", () => {
    expect(maskSecret("short")).toBe("********");
  });

  it("shows first-4 and last-4 chars for long values", () => {
    const masked = maskSecret("sk-proj-abcdefgh1234");
    expect(masked).toMatch(/^sk-p\.\.\.1234$/);
  });
});
