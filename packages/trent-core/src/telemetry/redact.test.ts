import { describe, it, expect } from "vitest";
import { redactTranscript, REDACTED_SECRET } from "./redact.js";

describe("redactTranscript", () => {
  it("redacts provider API keys already known to the error layer", () => {
    const out = redactTranscript("use sk-ant-api03-FAKEFAKEFAKE now");
    expect(out).not.toContain("sk-ant-api03-FAKEFAKEFAKE");
    expect(out).toContain(REDACTED_SECRET);
    expect(out).toContain("use");
    expect(out).toContain("now");
  });

  it("redacts GitHub and Google keys via the shared error-layer definition", () => {
    expect(redactTranscript("ghp_ABCDEFGHIJKLMNOP1234")).not.toContain("ghp_ABCDEFGHIJKLMNOP1234");
    expect(redactTranscript("AIzaSyFAKEFAKEFAKEFAKE0123")).not.toContain("AIzaSyFAKEFAKEFAKEFAKE0123");
  });

  it("redacts bearer tokens and Authorization headers", () => {
    const bearer = redactTranscript("Bearer abcdef0123456789abcdef0123456789");
    expect(bearer).not.toContain("abcdef0123456789abcdef0123456789");
    const header = redactTranscript("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(header).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(header).toContain("Authorization:");
  });

  it("redacts AWS access key ids and secret access keys", () => {
    const out = redactTranscript(
      "AKIAIOSFODNN7EXAMPLE and aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  it("redacts an entire private key PEM block", () => {
    const pem = [
      "here is the deploy key:",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234567890abcdefghijklmnop",
      "qrstuvwxyz0987654321ABCDEFGHIJKLMNOPQRSTUV",
      "-----END RSA PRIVATE KEY-----",
      "thanks",
    ].join("\n");
    const out = redactTranscript(pem);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA1234567890abcdefghijklmnop");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain("thanks");
  });

  it("redacts passwords embedded in connection strings but keeps the host", () => {
    const out = redactTranscript("postgres://trent:hunter2SuperSecret@db.internal:5432/app");
    expect(out).not.toContain("hunter2SuperSecret");
    expect(out).toContain("db.internal");
  });

  it("redacts long base64 runs", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamts";
    const out = redactTranscript(`payload=${blob}`);
    expect(out).not.toContain(blob);
  });

  it("leaves ordinary prose and code untouched", () => {
    const prose = "The orchestrator retries twice, then reports exit code 5 to the caller.";
    expect(redactTranscript(prose)).toBe(prose);
    const code = "const total = items.reduce((a, b) => a + b.costCents, 0);";
    expect(redactTranscript(code)).toBe(code);
  });

  it("handles empty and whitespace input", () => {
    expect(redactTranscript("")).toBe("");
    expect(redactTranscript("   ")).toBe("   ");
  });
});
