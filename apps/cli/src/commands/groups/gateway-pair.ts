/**
 * [C7] `trent gateway pair | pairings | revoke`: the operator's side of the default-deny pairing gate.
 *
 * An unknown sender is never routed to an agent (`PairingManager.authorize`); they get a short code
 * that expires in an hour. Until these commands existed nothing called `PairingManager.pair()`, so no
 * adapter admitted anyone without a hand-edited `gateway.json`. Now:
 *
 *   gateway pairings                          paired senders and the live codes, with who holds each
 *   gateway pair <platform> <code> [--admin]  pairs the sender who received that code (regular, or admin:
 *                                             an admin's button, reaction or reply decides approval cards)
 *   gateway revoke <platform> <sender-id>     unpairs them; their next message gets a fresh code
 *
 * Each writes the profile's `gateway.json` through a fresh `FileGatewayStore`, the path
 * `trent approvals approve` uses, and takes no lock: every mutation re-reads the file, so a gateway
 * that holds the profile (`trent gateway start`, or the service daemon) sees a pairing on the sender's
 * next message. Nothing here reads a secret, so nothing printed can carry one. An unknown or expired
 * code, an unknown platform, or a sender who is not paired exits 2 naming it. Under `--dry-run` each
 * answers `{dryRun, command, ...}` at exit 0 and reads nothing.
 */

import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { FileGatewayStore, PairingManager, PLATFORM_REGISTRY, listPlatformIds, type Tier } from "@trent/core/gateway/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

interface PairedView {
  readonly platform: string;
  readonly senderId: string;
  readonly scope: string;
  readonly tier: Tier;
  readonly pairedAt: string;
}

interface PendingView {
  readonly platform: string;
  readonly senderId: string;
  readonly scope: string;
  readonly code: string;
  readonly expiresAt: string;
}

function storeOf(ctx: CommandContext): FileGatewayStore {
  return new FileGatewayStore(path.join(ctx.config().getProfileDir(), "gateway.json"));
}

function refuse(operation: string, target: string, message: string): never {
  throw new TrentError({ code: EXIT.USAGE, operation, message, target });
}

function knownPlatform(operation: string, platform: string): string {
  if (PLATFORM_REGISTRY[platform] === undefined) refuse(operation, platform, `unknown platform ${platform}; known: ${listPlatformIds().join(", ")}`);
  return platform;
}

/** Paired senders, then the codes still inside their hour (the store keeps spent ones for the rate window). */
function pairings(ctx: CommandContext): { paired: PairedView[]; pending: PendingView[] } {
  const state = storeOf(ctx).snapshot();
  const now = Date.now();
  return {
    paired: state.pairings.map((p) => ({ platform: p.platform, senderId: p.senderId, scope: p.scope, tier: p.tier, pairedAt: p.pairedAt })),
    pending: state.pairingCodes
      .filter((c) => c.expiresAt > now)
      .sort((a, b) => a.issuedAt - b.issuedAt)
      .map((c) => ({ platform: c.platform, senderId: c.senderId, scope: c.scope, code: c.code, expiresAt: new Date(c.expiresAt).toISOString() })),
  };
}

const pairSpec: CommandSpec = {
  name: "pair <platform> <code>",
  description: "Pair the sender who received this pairing code, so their messages reach the agent",
  options: [{ flags: "--admin", description: "Pair as an admin: their button, reaction or reply decides approval cards" }],
  run(ctx, opts, args) {
    const tier: Tier = opts.admin === true ? "admin" : "regular";
    if (ctx.dryRun) return { data: { dryRun: true, command: "gateway pair", platform: String(args[0]), tier } };
    const platform = knownPlatform("gateway.pair", String(args[0]));
    try {
      const row = new PairingManager(storeOf(ctx)).pair(platform, String(args[1]), tier);
      return { data: { platform: row.platform, senderId: row.senderId, scope: row.scope, tier: row.tier, pairedAt: row.pairedAt } };
    } catch (error) {
      // `pair` throws this one error for a code that matches no live row; a store that cannot be read or written is not that.
      if (error instanceof Error && error.message.startsWith("Pairing failed:")) {
        refuse("gateway.pair", platform, `unknown or expired pairing code for ${platform}; trent gateway pairings lists the live ones`);
      }
      throw error;
    }
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; platform: string; senderId?: string; scope?: string; tier: string };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would pair")} ${ctx.theme.value(d.platform)} ${ctx.theme.meta(`as ${d.tier}`)}`];
    return [`  ${ctx.theme.success("paired")} ${ctx.theme.value(`${d.platform} ${String(d.senderId)}`)} ${ctx.theme.meta(`as ${d.tier} (${String(d.scope)})`)}`];
  },
};

const pairingsSpec: CommandSpec = {
  name: "pairings",
  description: "List paired senders and the pairing codes waiting for approval",
  run(ctx) {
    if (ctx.dryRun) return { data: { dryRun: true, command: "gateway pairings" } };
    return { data: pairings(ctx) };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; paired: PairedView[]; pending: PendingView[] };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would list")} the paired senders and the live pairing codes`];
    const lines = [ctx.theme.emphasis(`PAIRED (${d.paired.length})`)];
    for (const p of d.paired) lines.push(`  ${ctx.theme.value(p.platform.padEnd(12, " "))} ${ctx.theme.body(p.senderId)} ${ctx.theme.meta(`${p.tier}, ${p.scope}, since ${p.pairedAt}`)}`);
    lines.push(ctx.theme.emphasis(`WAITING (${d.pending.length})`));
    for (const c of d.pending) lines.push(`  ${ctx.theme.value(c.platform.padEnd(12, " "))} ${ctx.theme.body(c.senderId)} ${ctx.theme.needsApproval(c.code)} ${ctx.theme.meta(`expires ${c.expiresAt}`)}`);
    if (d.pending.length > 0) lines.push(`  ${ctx.theme.meta("pair one with trent gateway pair <platform> <code> [--admin]")}`);
    return lines;
  },
};

const revokeSpec: CommandSpec = {
  name: "revoke <platform> <sender-id>",
  description: "Unpair a sender; their next message gets a new pairing code",
  run(ctx, _opts, args) {
    if (ctx.dryRun) return { data: { dryRun: true, command: "gateway revoke", platform: String(args[0]), senderId: String(args[1]) } };
    const platform = knownPlatform("gateway.revoke", String(args[0]));
    const senderId = String(args[1]);
    const removed = new PairingManager(storeOf(ctx)).revoke(platform, senderId);
    if (removed === 0) refuse("gateway.revoke", `${platform} ${senderId}`, `no ${platform} sender ${senderId} is paired; trent gateway pairings lists who is`);
    return { data: { platform, senderId, removed } };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; platform: string; senderId: string; removed?: number };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would revoke")} ${ctx.theme.value(`${d.platform} ${d.senderId}`)}`];
    return [`  ${ctx.theme.needsApproval("revoked")} ${ctx.theme.value(`${d.platform} ${d.senderId}`)} ${ctx.theme.meta(`${String(d.removed)} pairing${d.removed === 1 ? "" : "s"} removed`)}`];
  },
};

/** Registered under `gateway` beside `gateway setup` (`./servers.ts`). */
export const gatewayPairSpecs: readonly CommandSpec[] = [pairSpec, pairingsSpec, revokeSpec];
