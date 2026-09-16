/**
 * The `audit` group: a signed export of the store's audit chain, and its verifier.
 *
 * `export` reads the durable SQLite store of this profile and writes NDJSON plus a detached
 * `.sig`; it refuses when only the in-process store is available, because a signed empty file
 * would look like a clean audit trail. `verify` needs nothing from the store: the file, its
 * `.sig`, and — when this profile has one — the profile's public key to say whether the signer
 * is us. `key` prints the public key and its fingerprint; the private key never leaves the profile.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  auditKeyExists,
  auditKeyPaths,
  auditSourceFor,
  defaultExportPath,
  exportAudit,
  loadOrCreateAuditKey,
  publicKeyFingerprint,
  readAuditPublicKey,
  signaturePathFor,
  verifyAuditExport,
  type AuditVerifyReport,
} from "@trent/core/audit/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import { openStore } from "../../runtime/headless.js";

function resolveOut(ctx: CommandContext, opts: Record<string, unknown>): string {
  const now = ctx.overrides.now ?? (() => new Date());
  return typeof opts.out === "string" && opts.out.length > 0
    ? path.resolve(opts.out)
    : defaultExportPath(process.cwd(), now());
}

interface VerifyData extends AuditVerifyReport {
  /** True when the signer is this profile's own audit key. */
  trusted: boolean;
}

export const auditSpec: CommandSpec = {
  name: "audit",
  description: "Export and verify the signed audit chain",
  subcommands: [
    {
      name: "export",
      description: "Write the audit chain as NDJSON with a detached ed25519 signature",
      options: [{ flags: "--out <file>", description: "Output file (default: ./trent-audit-<date>.ndjson)" }],
      async run(ctx, opts) {
        const file = resolveOut(ctx, opts);
        const signatureFile = signaturePathFor(file);
        if (ctx.dryRun) return { data: { dryRun: true, command: "audit export", file, signatureFile } };

        const profileDir = ctx.config().getProfileDir();
        const { store, durable } = await openStore(`file:${profileDir}/trent.db`);
        try {
          if (!durable) {
            throw new TrentError({
              code: EXIT.CONFIG,
              operation: "audit.export",
              message: "the durable store could not be opened, so there is no audit chain to export (bun:sqlite is required)",
              target: path.join(profileDir, "trent.db"),
            });
          }
          const key = loadOrCreateAuditKey(profileDir);
          const result = await exportAudit({
            source: auditSourceFor(store),
            outFile: file,
            key,
            ...(ctx.overrides.now === undefined ? {} : { now: ctx.overrides.now }),
          });
          return { data: { ...result } };
        } finally {
          // The durable store holds a connection; the in-process fallback has nothing to release.
          await (store as { close?: () => Promise<void> }).close?.();
        }
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; file: string; signatureFile: string; rows?: number; fingerprint?: string };
        if (d.dryRun === true) {
          return [ctx.theme.meta(`would write ${d.file} and ${d.signatureFile}`)];
        }
        return [
          ctx.theme.emphasis("AUDIT EXPORT"),
          `  ${ctx.theme.body("rows")}      ${ctx.theme.value(String(d.rows))}`,
          `  ${ctx.theme.body("file")}      ${ctx.theme.value(d.file)}`,
          `  ${ctx.theme.body("signature")} ${ctx.theme.value(d.signatureFile)}`,
          `  ${ctx.theme.body("signer")}    ${ctx.theme.value(String(d.fingerprint))}`,
        ];
      },
    },
    {
      name: "verify <file>",
      description: "Re-walk the hash chain of an export and check its signature",
      async run(ctx, _opts, args) {
        const file = path.resolve(String(args[0]));
        const signatureFile = signaturePathFor(file);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "audit verify", file, signatureFile, exists: fs.existsSync(file) && fs.existsSync(signatureFile) } };
        }
        const profileDir = ctx.config().getProfileDir();
        // With a key of our own, only our own signatures pass; without one the embedded key is
        // used and `trusted` is false so the caller knows the signer is unvouched for.
        const ownKey = readAuditPublicKey(profileDir);
        const report = await verifyAuditExport(file, ownKey === null ? {} : { trustedPublicKeyPem: ownKey });
        const trusted = ownKey !== null && report.signer !== "" && publicKeyFingerprint(ownKey) === report.signer;
        const data: VerifyData = { ...report, trusted };
        return { data: { ...data }, exitCode: report.ok ? EXIT.OK : EXIT.AUTH };
      },
      render(data, ctx) {
        const d = data as unknown as VerifyData & { dryRun?: boolean; exists?: boolean };
        if (d.dryRun === true) {
          return [ctx.theme.meta(`would verify ${d.file} against ${d.signatureFile}${d.exists === true ? "" : " (not both present)"}`)];
        }
        const lines = [
          ctx.theme.emphasis(d.ok ? "AUDIT EXPORT VERIFIED" : "AUDIT EXPORT FAILED VERIFICATION"),
          `  ${ctx.theme.body("rows")}    ${ctx.theme.value(String(d.rows))}`,
          `  ${ctx.theme.body("signer")}  ${ctx.theme.value(d.signer || "(none)")} ${ctx.theme.meta(d.trusted ? "this profile's key" : "not this profile's key")}`,
          `  ${ctx.theme.body("digest")}  ${ctx.theme.value(d.digest)}`,
        ];
        for (const f of d.failures) {
          lines.push(`  ${ctx.theme.body(f.kind)}${f.row === undefined ? "" : ` row ${f.row}`}: ${f.message}`);
        }
        return lines;
      },
    },
    {
      name: "key",
      description: "Print this profile's audit public key and fingerprint",
      run(ctx) {
        const profileDir = ctx.config().getProfileDir();
        const paths = auditKeyPaths(profileDir);
        if (ctx.dryRun) {
          const exists = auditKeyExists(profileDir);
          const existing = exists ? readAuditPublicKey(profileDir) : null;
          return {
            data: {
              dryRun: true,
              command: "audit key",
              exists,
              path: paths.publicKey,
              ...(existing === null ? {} : { fingerprint: publicKeyFingerprint(existing) }),
            },
          };
        }
        const key = loadOrCreateAuditKey(profileDir);
        return { data: { fingerprint: key.fingerprint, publicKey: key.publicKeyPem, path: paths.publicKey } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; exists?: boolean; fingerprint?: string; publicKey?: string; path: string };
        if (d.dryRun === true) {
          return [ctx.theme.meta(d.exists === true ? `key exists at ${d.path} (${d.fingerprint})` : `would generate a key at ${d.path}`)];
        }
        return [
          ctx.theme.emphasis("AUDIT SIGNING KEY"),
          `  ${ctx.theme.body("fingerprint")} ${ctx.theme.value(String(d.fingerprint))}`,
          `  ${ctx.theme.body("public key")}  ${ctx.theme.value(d.path)}`,
          ...String(d.publicKey ?? "").trimEnd().split("\n").map((l) => `  ${l}`),
        ];
      },
    },
  ],
};
