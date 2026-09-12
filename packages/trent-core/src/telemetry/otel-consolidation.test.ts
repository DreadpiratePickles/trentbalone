import { describe, it, expect } from "vitest";
import { OTelExporter } from "../traces/OTelExporter.js";
import { redactTranscript } from "./redact.js";

describe("one definition of a secret", () => {
  const exporter = new OTelExporter();

  const samples = [
    "sk-ant-api03-FAKEFAKEFAKE",
    "Authorization: Bearer abcdef0123456789abcdef0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "postgres://trent:hunter2SuperSecret@db.internal:5432/app",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "plain prose with no secret at all",
  ];

  it("routes exporter redaction through the shared transcript redactor", () => {
    for (const sample of samples) {
      expect(exporter.redactSecrets(sample)).toBe(redactTranscript(sample));
    }
  });

  it("catches transcript shapes the exporter's old regex missed", () => {
    const out = exporter.redactSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
