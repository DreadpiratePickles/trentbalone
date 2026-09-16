/**
 * Export and verify: the store's audit rows go out as NDJSON in chain order with a detached
 * ed25519 signature over the file's sha256; verify re-walks the hash chain (the same formula the
 * wrapped application's `computeAuditHash` uses) and checks the signature. A tampered row is
 * named by its line number, and the report says whether it was the chain or the signature.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditSourceFor,
  computeAuditRowHash,
  defaultExportPath,
  exportAudit,
  signaturePathFor,
  type AuditRow,
  type AuditRowSource,
} from "./export.js";
import { generateAuditKeyPair } from "./signing.js";
import type { AuditScenarioResult } from "../store/scenarios.js";
import { verifyAuditExport } from "./verify.js";

const SCENARIO_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../store/scenario-runner.ts");

/** The durable store's driver is bun:sqlite, so the real store is exercised under Bun as a child process. */
function findBun(): string {
  const fromEnv = process.env.TRENT_BUN_BIN;
  if (fromEnv !== undefined && fromEnv !== "" && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const onPath = execSync("command -v bun", { encoding: "utf8" }).trim();
    if (onPath !== "") return onPath;
  } catch {
    /* fall through to the standard install location */
  }
  const standard = path.join(os.homedir(), ".bun", "bin", "bun");
  if (fs.existsSync(standard)) return standard;
  throw new Error("bun not found; set TRENT_BUN_BIN or put bun on PATH");
}

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trent-audit-export-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The wrapped application's formula, spelled out here so the test does not trust the module under test. */
function webHash(prevHash: string, r: Omit<AuditRow, "hash" | "prevHash">): string {
  return createHash("sha256")
    .update(prevHash + r.id + r.actor + r.action + r.objectId + r.summary + r.createdAt)
    .digest("hex");
}

/** Three rows for one company, chained from `genesis`, deliberately handed over out of order. */
function seededRows(): AuditRow[] {
  const base = [
    { id: "aud_1", actor: "user", action: "company.create", objectType: "company", objectId: "co_1", summary: "created", createdAt: "2026-09-15T09:00:00.000Z" },
    { id: "aud_2", actor: "agent", action: "run.start", objectType: "run", objectId: "run_1", summary: "objective: ship", createdAt: "2026-09-15T09:01:00.000Z" },
    { id: "aud_3", actor: "system", action: "run.done", objectType: "run", objectId: "run_1", summary: "completed", createdAt: "2026-09-15T09:02:00.000Z" },
  ];
  const rows: AuditRow[] = [];
  let prevHash = "genesis";
  for (const r of base) {
    const hash = webHash(prevHash, { ...r, companyId: "co_1" });
    rows.push({ ...r, companyId: "co_1", hash, prevHash });
    prevHash = hash;
  }
  return [rows[2]!, rows[0]!, rows[1]!];
}

function sourceOf(rows: AuditRow[]): AuditRowSource {
  return { listAuditRows: async () => rows };
}

describe("computeAuditRowHash", () => {
  it("matches the wrapped application's computeAuditHash formula", () => {
    const [row] = seededRows();
    expect(computeAuditRowHash(row!)).toBe(webHash(row!.prevHash, row!));
  });
});

describe("exportAudit", () => {
  it("writes the rows as one NDJSON line each in chain order, plus a one-line .sig", async () => {
    const dir = tmpDir();
    const outFile = path.join(dir, "audit.ndjson");
    const key = generateAuditKeyPair();
    const now = () => new Date("2026-09-15T10:00:00.000Z");

    const result = await exportAudit({ source: sourceOf(seededRows()), outFile, key, now });

    expect(result.rows).toBe(3);
    expect(result.signatureFile).toBe(signaturePathFor(outFile));
    const lines = fs.readFileSync(outFile, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as AuditRow).id)).toEqual(["aud_1", "aud_2", "aud_3"]);

    const sigLines = fs.readFileSync(result.signatureFile, "utf8").split("\n").filter((l) => l.length > 0);
    expect(sigLines).toHaveLength(1);
    const sig = JSON.parse(sigLines[0]!) as Record<string, unknown>;
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.fingerprint).toBe(key.fingerprint);
    expect(sig.rows).toBe(3);
    expect(sig.signedAt).toBe("2026-09-15T10:00:00.000Z");
    expect(typeof sig.signature).toBe("string");
    expect(sig.publicKey).toBe(key.publicKeyPem);
    expect(String(sig.privateKey ?? "")).toBe("");
  });

  it("names the default export after the date, in the working directory", () => {
    expect(defaultExportPath("/work", new Date("2026-09-15T23:59:00.000Z"))).toBe("/work/trent-audit-2026-09-15.ndjson");
  });
});

describe("verifyAuditExport", () => {
  async function exported(): Promise<{ outFile: string; key: ReturnType<typeof generateAuditKeyPair> }> {
    const outFile = path.join(tmpDir(), "audit.ndjson");
    const key = generateAuditKeyPair();
    await exportAudit({ source: sourceOf(seededRows()), outFile, key });
    return { outFile, key };
  }

  it("passes on an untouched export and reports the signer fingerprint", async () => {
    const { outFile, key } = await exported();
    const report = await verifyAuditExport(outFile);
    expect(report.ok).toBe(true);
    expect(report.rows).toBe(3);
    expect(report.signer).toBe(key.fingerprint);
    expect(report.failures).toEqual([]);
  });

  it("fails on a flipped byte in row 2, naming the row and both the chain and the signature", async () => {
    const { outFile } = await exported();
    const bytes = fs.readFileSync(outFile);
    const lines = bytes.toString("utf8").split("\n");
    const target = lines[1]!;
    const at = target.indexOf("objective: ship") + "objective: ship".length - 1;
    lines[1] = `${target.slice(0, at)}${target[at] === "p" ? "q" : "p"}${target.slice(at + 1)}`;
    fs.writeFileSync(outFile, lines.join("\n"));

    const report = await verifyAuditExport(outFile);
    expect(report.ok).toBe(false);
    expect(report.rows).toBe(3);
    const chain = report.failures.find((f) => f.kind === "chain");
    expect(chain?.row).toBe(2);
    expect(report.failures.some((f) => f.kind === "signature")).toBe(true);
  });

  it("fails on a broken link when a row's prevHash does not point at its predecessor", async () => {
    const outFile = path.join(tmpDir(), "audit.ndjson");
    const rows = seededRows().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const forged = { ...rows[2]!, prevHash: "genesis" };
    forged.hash = computeAuditRowHash(forged);
    await exportAudit({ source: sourceOf([rows[0]!, rows[1]!, forged]), outFile, key: generateAuditKeyPair() });

    const report = await verifyAuditExport(outFile);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([expect.objectContaining({ kind: "chain", row: 3 })]);
  });

  it("fails the signature when the .sig was made by another key, even if the chain is intact", async () => {
    const { outFile } = await exported();
    const sigFile = signaturePathFor(outFile);
    const sig = JSON.parse(fs.readFileSync(sigFile, "utf8")) as Record<string, unknown>;
    const other = generateAuditKeyPair();
    fs.writeFileSync(sigFile, `${JSON.stringify({ ...sig, publicKey: other.publicKeyPem, fingerprint: other.fingerprint })}\n`);

    const report = await verifyAuditExport(outFile);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([expect.objectContaining({ kind: "signature" })]);
  });

  it("refuses a .sig whose embedded key is not the trusted key it was given", async () => {
    const { outFile, key } = await exported();
    const trusted = generateAuditKeyPair();
    const report = await verifyAuditExport(outFile, { trustedPublicKeyPem: trusted.publicKeyPem });
    expect(report.ok).toBe(false);
    expect(report.signer).toBe(key.fingerprint);
    expect(report.failures[0]?.kind).toBe("signature");
    expect(report.failures[0]?.message).toContain(trusted.fingerprint);
  });

  it("reports a missing .sig as a signature failure rather than throwing", async () => {
    const { outFile } = await exported();
    fs.rmSync(signaturePathFor(outFile));
    const report = await verifyAuditExport(outFile);
    expect(report.ok).toBe(false);
    expect(report.failures[0]?.kind).toBe("signature");
  });
});

describe("auditSourceFor", () => {
  it("uses a store's own listAuditRows when it has one", async () => {
    const rows = seededRows();
    const source = auditSourceFor({ listAuditRows: async () => rows });
    expect(await source.listAuditRows()).toBe(rows);
  });

  it("reads the AuditLog table through a Prisma-backed store's client, oldest first", async () => {
    const calls: unknown[] = [];
    const rows = seededRows().map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
    const store = { prisma: { auditLog: { findMany: async (args: unknown) => { calls.push(args); return rows; } } } };
    const listed = await auditSourceFor(store).listAuditRows();
    expect(listed.map((r) => r.createdAt)).toEqual(rows.map((r) => r.createdAt.toISOString()));
    expect(calls[0]).toMatchObject({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  });

  it("refuses a store that has no audit table to read", () => {
    expect(() => auditSourceFor({ createRun: async () => undefined })).toThrow(/audit/);
  });
});

describe("exportAudit over the durable SQLite store, under Bun", () => {
  it("StorePort.listAuditRows feeds three chained rows from a real store into an export of three lines that verifies", () => {
    const file = path.join(tmpDir(), "trent.db");
    const stdout = execFileSync(findBun(), [SCENARIO_RUNNER, "audit", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const result = JSON.parse(stdout) as AuditScenarioResult;
    expect(result.listedIds).toEqual(["aud_1", "aud_2", "aud_3"]);
    expect(result.listedPrevHashes[0]).toBe("genesis");
    expect(result.listedForOtherCompany).toBe(0);
    expect(result.exportedRows).toBe(3);
    expect(result.lines).toBe(3);
    expect(result.verified).toBe(true);
    expect(result.failures).toEqual([]);
  }, 120_000);
});
