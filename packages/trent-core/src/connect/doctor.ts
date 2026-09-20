/**
 * The doctor line per provider, in the shape `doctor/types.ts` `CheckResult` uses so a doctor
 * check can emit them unchanged. Built from `ConnectStore.read`, which carries no value, so
 * this module cannot leak one even by mistake.
 */
import { connectProvider, type ConnectProviderId } from "./providers.js";
import type { ConnectStore } from "./store.js";

export interface ConnectDoctorLine {
  readonly category: "connect";
  readonly provider: ConnectProviderId;
  readonly name: string;
  readonly status: "ok" | "warn" | "skip";
  readonly message: string;
  readonly fixHint?: string;
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
      return { ...base, status: "ok", message: `${record.name}: connected (${record.present.join(", ")})` };
    }
    const scopes = `${record.scopes.length} scope${record.scopes.length === 1 ? "" : "s"}`;
    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime()) {
      const renewable = record.hasRefreshToken || provider.oauth?.refresh === "exchange_long_lived";
      return {
        ...base,
        status: "warn",
        message: `${record.name}: token expired at ${record.expiresAt} (${scopes})`,
        fixHint: renewable ? `trent connect refresh ${record.provider}` : provider.doctor.fixHint,
      };
    }
    const expiry = record.expiresAt === undefined ? "no expiry reported" : `expires ${record.expiresAt}`;
    return { ...base, status: "ok", message: `${record.name}: connected (${scopes}, ${expiry})` };
  });
}
