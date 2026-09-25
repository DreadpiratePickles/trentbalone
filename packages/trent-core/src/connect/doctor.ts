/**
 * The doctor line per provider, in the shape `doctor/types.ts` `CheckResult` uses so a doctor
 * check can emit them unchanged. Built from `ConnectStore.read`, which carries no value, so
 * this module cannot leak one even by mistake.
 *
 * [P1-D] A line for a connected provider names the file it resolved from, and says when that is
 * the default profile's (inherited); an inherited expired token points at the refresh that runs
 * THERE, since this profile never writes that file.
 */
import { connectProvider, type ConnectProviderId } from "./providers.js";
import type { ConnectionRecord, ConnectStore } from "./store.js";

export interface ConnectDoctorLine {
  readonly category: "connect";
  readonly provider: ConnectProviderId;
  readonly name: string;
  readonly status: "ok" | "warn" | "skip";
  readonly message: string;
  readonly fixHint?: string;
}

/** Where the values came from, by path only. */
function from(record: ConnectionRecord): string {
  return record.source.inherited ? `from ${record.source.path} (the default profile's file, inherited)` : `from ${record.source.path}`;
}

export function connectDoctorLines(store: ConnectStore, now: Date = new Date()): ConnectDoctorLine[] {
  return store.list().map((record) => {
    const provider = connectProvider(record.provider);
    const base = { category: "connect" as const, provider: record.provider, name: provider.doctor.name };
    if (!record.connected) {
      const reason = record.kind === "oauth2" && record.appConfigured ? "app registered, not authorized" : "not connected";
      return { ...base, status: "skip", message: `${record.name}: ${reason}`, fixHint: provider.doctor.fixHint };
    }
    if (record.kind !== "oauth2") {
      return { ...base, status: "ok", message: `${record.name}: connected (${record.present.join(", ")}) ${from(record)}` };
    }
    const scopes = `${record.scopes.length} scope${record.scopes.length === 1 ? "" : "s"}`;
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime()) {
      const renewable = record.hasRefreshToken || provider.oauth?.refresh === "exchange_long_lived";
      const refresh = record.source.inherited ? `trent --profile ${record.source.profile} connect refresh ${record.provider}` : `trent connect refresh ${record.provider}`;
      return {
        ...base,
        status: "warn",
        message: `${record.name}: token expired at ${record.expiresAt} (${scopes}) ${from(record)}`,
        fixHint: renewable ? refresh : provider.doctor.fixHint,
      };
    }
    const expiry = record.expiresAt === undefined ? "no expiry reported" : `expires ${record.expiresAt}`;
    return { ...base, status: "ok", message: `${record.name}: connected (${scopes}, ${expiry}) ${from(record)}` };
  });
}
