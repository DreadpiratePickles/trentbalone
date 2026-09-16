/**
 * `trent audit export|verify|key`: a signed NDJSON export of the store's audit chain. `export`
 * needs the durable store, so under plain Node (no bun:sqlite) it refuses rather than signing an
 * empty file from the in-process fallback; `verify` works on any export, including one produced
 * elsewhere, and reports whether the signer is this profile's key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { exportAudit, generateAuditKeyPair, loadOrCreateAuditKey, signaturePathFor, type AuditRow } from "@trent/core/audit/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;
let work: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-audit-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-audit-work-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function chained(): AuditRow[] {
  const rows: AuditRow[] = [];
  let prevHash = "genesis";
  for (let i = 1; i <= 3; i++) {
    const r = { id: `aud_${i}`, companyId: "co_1", actor: "user", action: `step.${i}`, objectType: "run", objectId: "run_1", summary: `row ${i}`, createdAt: `2026-09-15T09:0${i}:00.000Z` };
    const hash = createHash("sha256").update(prevHash + r.id + r.actor + r.action + r.objectId + r.summary + r.createdAt).digest("hex");
    rows.push({ ...r, hash, prevHash });
    prevHash = hash;
  }
  return rows;
}

type VerifyData = { ok: boolean; rows: number; signer: string; trusted: boolean; failures: { kind: string; row?: number }[] };

describe("trent audit", () => {
  it("export --dry-run --json exits 0 and names the files it would write without creating them", async () => {
    const result = await runCli(["audit", "export", "--out", path.join(work, "out.ndjson"), "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { dryRun: boolean; file: string; signatureFile: string };
    expect(data.dryRun).toBe(true);
    expect(data.file).toBe(path.join(work, "out.ndjson"));
    expect(data.signatureFile).toBe(path.join(work, "out.ndjson.sig"));
    expect(fs.existsSync(data.file)).toBe(false);
    expect(fs.existsSync(path.join(home, "keys", "audit.key"))).toBe(false);
  });

  it("export refuses when the durable store cannot be opened, rather than signing an empty file", async () => {
    const out = path.join(work, "out.ndjson");
    const result = await runCli(["audit", "export", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(fs.existsSync(out)).toBe(false);
    expect(result.stdout).toContain("durable");
  });

  it("verify --json returns { ok, rows, signer } for an export signed by this profile's key", async () => {
    const key = loadOrCreateAuditKey(home);
    const out = path.join(work, "trent-audit.ndjson");
    await exportAudit({ source: { listAuditRows: async () => chained() }, outFile: out, key });

    const result = await runCli(["audit", "verify", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as VerifyData;
    expect(data).toMatchObject({ ok: true, rows: 3, signer: key.fingerprint, trusted: true, failures: [] });
  });

  it("verify marks an export signed by another key as untrusted and fails with the auth code", async () => {
    loadOrCreateAuditKey(home);
    const out = path.join(work, "foreign.ndjson");
    const other = generateAuditKeyPair();
    await exportAudit({ source: { listAuditRows: async () => chained() }, outFile: out, key: other });

    const result = await runCli(["audit", "verify", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.AUTH);
    const data = JSON.parse(result.stdout) as VerifyData;
    expect(data.ok).toBe(false);
    expect(data.signer).toBe(other.fingerprint);
    expect(data.trusted).toBe(false);
  });

  it("verify names the tampered row and the kind of failure", async () => {
    const out = path.join(work, "tampered.ndjson");
    await exportAudit({ source: { listAuditRows: async () => chained() }, outFile: out, key: generateAuditKeyPair() });
    const lines = fs.readFileSync(out, "utf8").split("\n");
    lines[1] = lines[1]!.replace("row 2", "row 9");
    fs.writeFileSync(out, lines.join("\n"));

    const result = await runCli(["audit", "verify", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.AUTH);
    const data = JSON.parse(result.stdout) as VerifyData;
    expect(data.ok).toBe(false);
    expect(data.failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "chain", row: 2 }), expect.objectContaining({ kind: "signature" })]));
    expect(fs.existsSync(signaturePathFor(out))).toBe(true);
  });

  it("verify --dry-run --json exits 0 and reports whether the file and its .sig are present", async () => {
    const result = await runCli(["audit", "verify", path.join(work, "missing.ndjson"), "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, exists: false, signatureFile: path.join(work, "missing.ndjson.sig") });
  });

  it("verify of a file that does not exist is a usage error", async () => {
    const result = await runCli(["audit", "verify", path.join(work, "missing.ndjson"), "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
  });

  it("key prints the public key and its fingerprint, creates the key on first use, and never the private key", async () => {
    const result = await runCli(["audit", "key", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { fingerprint: string; publicKey: string; path: string };
    expect(data.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(data.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(result.stdout).not.toContain("PRIVATE KEY");
    expect(fs.statSync(path.join(home, "keys", "audit.key")).mode & 0o777).toBe(0o600);
    expect(data.path).toBe(path.join(home, "keys", "audit.pub"));

    const human = await runCli(["audit", "key", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(data.fingerprint);
    expect(human.stdout).not.toContain("PRIVATE KEY");
  });

  it("key --dry-run does not create a key that is not there yet", async () => {
    const result = await runCli(["audit", "key", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, exists: false });
    expect(fs.existsSync(path.join(home, "keys", "audit.key"))).toBe(false);
  });
});
