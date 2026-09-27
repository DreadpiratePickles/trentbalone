/**
 * [S5.3] `trent panic`: the big red button.
 *
 * One command that (a) revokes EVERY gateway pairing at once, so no messaging sender can reach an
 * agent until the operator pairs them again, and (b) asks any in-flight work on this profile to
 * stop. Both halves are real, not reassurance:
 *
 *   - The revoke is `PairingManager.revokeAll` over the profile's `gateway.json` — the same store
 *     and path `trent gateway revoke` writes. After it, `trent gateway pairings` is empty and the
 *     next message from any former sender gets a fresh pairing code.
 *   - The stop is the profile's own lock records. A running gateway holds the gateway lock; a run,
 *     the service daemon, cron and the heartbeat each register as a profile WRITER. Every one of
 *     them releases and shuts down on SIGTERM (`../../signals.ts`, `service-daemon.ts`), so panic
 *     signals those live pids. It reaches only what left a live lock on this profile; it cannot
 *     reach a bare `trent run` in another terminal that took no writer lock, and the report says as
 *     much rather than pretending otherwise.
 *
 * `--dry-run` lists what it WOULD revoke and which pids it WOULD signal, and touches nothing.
 * Nothing here reads a secret, so nothing it prints can carry one.
 */
import path from "node:path";
import { FileGatewayStore, PairingManager, type PairingRow } from "@trent/core/gateway/index.js";
import { liveGatewayHolder, liveWriters, type ProfileLockHolder } from "@trent/core/profile/locks.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** The signal every long-running Trent process releases its locks and shuts down on. */
const STOP_SIGNAL: NodeJS.Signals = "SIGTERM";

interface PairedView {
  readonly platform: string;
  readonly senderId: string;
  readonly scope: string;
  readonly tier: string;
  readonly pairedAt: string;
}

interface StopTarget {
  readonly pid: number;
  readonly role: "gateway" | "writer";
  readonly label: string;
}

interface PanicData {
  readonly dryRun?: boolean;
  readonly command: "panic";
  readonly revoked: number;
  readonly pairings: readonly PairedView[];
  readonly stopTargets: readonly StopTarget[];
  readonly signalled: boolean;
  readonly signal: string;
}

function storeOf(ctx: CommandContext): FileGatewayStore {
  return new FileGatewayStore(path.join(ctx.config().getProfileDir(), "gateway.json"));
}

function view(row: PairingRow): PairedView {
  return { platform: row.platform, senderId: row.senderId, scope: row.scope, tier: row.tier, pairedAt: row.pairedAt };
}

/**
 * The live processes on this profile panic can signal: the gateway lock holder and every registered
 * writer, deduped by pid and never this process itself. Each is a real, live lock record.
 */
function stopTargets(ctx: CommandContext): StopTarget[] {
  const profileDir = ctx.config().getProfileDir();
  const seen = new Set<number>([process.pid]);
  const targets: StopTarget[] = [];
  const add = (holder: ProfileLockHolder | null, role: StopTarget["role"]): void => {
    if (holder === null || holder.pid <= 0 || seen.has(holder.pid)) return;
    seen.add(holder.pid);
    targets.push({ pid: holder.pid, role, label: holder.label });
  };
  add(liveGatewayHolder(profileDir), "gateway");
  for (const writer of liveWriters(profileDir)) add(writer, "writer");
  return targets;
}

export const panicSpec: CommandSpec = {
  name: "panic",
  description: "Revoke every gateway pairing and ask any in-flight work on this profile to stop",
  run(ctx) {
    const targets = stopTargets(ctx);

    if (ctx.dryRun) {
      const pairings = storeOf(ctx).snapshot().pairings.map(view);
      return { data: { dryRun: true, command: "panic", revoked: 0, pairings, stopTargets: targets, signalled: false, signal: STOP_SIGNAL } };
    }

    // Snapshot who is paired BEFORE the revoke, so the report names exactly what it dropped.
    const before = storeOf(ctx).snapshot().pairings.map(view);
    const revoked = new PairingManager(storeOf(ctx)).revokeAll();

    let signalled = false;
    for (const target of targets) {
      try {
        process.kill(target.pid, STOP_SIGNAL);
        signalled = true;
      } catch {
        // The process may have exited between the lock read and the signal; a stale lock is not a failure.
      }
    }

    return { data: { command: "panic", revoked, pairings: before, stopTargets: targets, signalled, signal: STOP_SIGNAL } };
  },
  render(data, ctx) {
    const d = data as unknown as PanicData;
    const lines = [ctx.theme.emphasis("PANIC")];

    if (d.dryRun === true) {
      lines.push(`  ${ctx.theme.meta("would revoke")} ${ctx.theme.value(`${d.pairings.length} pairing${d.pairings.length === 1 ? "" : "s"}`)}`);
      for (const p of d.pairings) lines.push(`    ${ctx.theme.value(`${p.platform} ${p.senderId}`)} ${ctx.theme.meta(`${p.tier}, ${p.scope}`)}`);
      lines.push(`  ${ctx.theme.meta(`would signal ${STOP_SIGNAL} to`)} ${ctx.theme.value(`${d.stopTargets.length} process(es)`)}`);
      for (const t of d.stopTargets) lines.push(`    ${ctx.theme.value(`pid ${t.pid}`)} ${ctx.theme.meta(`${t.role} ${t.label}`)}`);
      return lines;
    }

    lines.push(`  ${ctx.theme.needsApproval("revoked")} ${ctx.theme.value(`${d.revoked} pairing${d.revoked === 1 ? "" : "s"}`)}`);
    for (const p of d.pairings) lines.push(`    ${ctx.theme.value(`${p.platform} ${p.senderId}`)} ${ctx.theme.meta(`${p.tier}, ${p.scope}`)}`);
    if (d.stopTargets.length === 0) {
      lines.push(`  ${ctx.theme.meta("no live gateway, run, service or heartbeat lock on this profile to stop")}`);
      lines.push(`  ${ctx.theme.meta("a bare run in another terminal takes no writer lock — stop it there with Ctrl+C")}`);
    } else {
      lines.push(`  ${ctx.theme.needsApproval(`signalled ${d.signal} to`)} ${ctx.theme.value(`${d.stopTargets.length} process(es)`)}`);
      for (const t of d.stopTargets) lines.push(`    ${ctx.theme.value(`pid ${t.pid}`)} ${ctx.theme.meta(`${t.role} ${t.label}`)}`);
    }
    return lines;
  },
};
