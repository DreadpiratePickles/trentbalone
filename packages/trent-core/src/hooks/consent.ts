/**
 * Hook consent.
 *
 * A hook is arbitrary code a config file asks Trent to run on every tool call. A config file
 * arrives by many routes — a repo, a teammate, a restored backup, a `config set` a model talked
 * the user into — so the record is a hash of the EXACT spec: the argv, the timeout and the match
 * filter, scoped by hook kind. Change any of them and the consent is gone until `trent hooks
 * consent` grants it again, and until then the hook never runs and the run says so once.
 *
 * The file is `<profileDir>/hooks-consent.json`, written 0600 like every other profile secret.
 * It holds hashes only: not the commands, so the file itself tells an attacker nothing useful.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HookKind, HookSpec } from "./types.js";

export const CONSENT_FILE = "hooks-consent.json";
export const CONSENT_VERSION = 1;

export interface ConsentRecord {
  readonly version: number;
  readonly consented: readonly string[];
}

/** Canonical form: key order cannot change the hash, but any value can. */
export function hookSpecHash(kind: HookKind, spec: HookSpec): string {
  const canonical = JSON.stringify([kind, spec.command, spec.timeout_ms ?? null, spec.match?.tool ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function consentPath(profileDir: string): string {
  return path.join(profileDir, CONSENT_FILE);
}

/** A missing or unreadable record is NO consent, never an error: the safe direction is silence. */
export function readConsent(profileDir: string): ConsentRecord {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(consentPath(profileDir), "utf8"));
    if (!raw || typeof raw !== "object") return { version: CONSENT_VERSION, consented: [] };
    const entries = (raw as { consented?: unknown }).consented;
    const consented = Array.isArray(entries) ? entries.filter((value): value is string => typeof value === "string") : [];
    const version = (raw as { version?: unknown }).version;
    return { version: typeof version === "number" ? version : CONSENT_VERSION, consented };
  } catch {
    return { version: CONSENT_VERSION, consented: [] };
  }
}

/** Replaces the record: consent is granted for the hooks in the config as it stands, not cumulatively. */
export function writeConsent(profileDir: string, hashes: readonly string[]): ConsentRecord {
  fs.mkdirSync(profileDir, { recursive: true });
  const record: ConsentRecord = { version: CONSENT_VERSION, consented: [...new Set(hashes)] };
  const file = consentPath(profileDir);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file, so an existing record is re-chmodded.
  fs.chmodSync(file, 0o600);
  return record;
}

export function isConsented(profileDir: string, kind: HookKind, spec: HookSpec): boolean {
  return readConsent(profileDir).consented.includes(hookSpecHash(kind, spec));
}
