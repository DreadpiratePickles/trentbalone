/**
 * [D11] Which workspaces hold network-derived bytes (council verdict 2026-09-26, red-team Break 20).
 *
 * A `git clone`, `curl -o`, `npm install` or `pip download` writes bytes somebody outside this
 * machine authored into the workspace, and a later `read_file`, `cat` or `open()` hands them to the
 * model as if the operator had written them. The provenance gate (`governance/provenance.ts`) can
 * only quarantine what it knows is untrusted, so this module is how it knows.
 *
 * THE RULE, chosen for being simple and sound rather than precise:
 *   1. A terminal command the egress router sends to the network seat (`NEEDS_EGRESS`, or an
 *      explicit `network: true`) and that really has a network — the egress seat on Docker, or ANY
 *      such command on the local backend, where nothing isolates it — returns network-derived
 *      output. The terminal adapter tags that record `untrusted` itself.
 *   2. Running it marks the WORKSPACE network-derived, before the command runs (a download that
 *      fails halfway has still written), for the life of this process.
 *   3. From then on, every call to an adapter declared `readsWorkspace` in
 *      `tools/provenance-registry.ts` (file_ops, terminal, code_execution) on that workspace is
 *      tagged untrusted by the provenance wrapper — in any step, run or tool build — so a memory
 *      write or skill write in the same taint scope is held or refused.
 *
 * This is option (a) of the council brief widened from "the same context" to "the same workspace
 * for the rest of the process", because the files outlive the step that fetched them. It does not
 * try to track WHICH paths a command wrote (option b): `npm install` writes node_modules, a
 * post-install script can write anywhere, and a path-precise rule would be a guess.
 *
 * RESIDUAL, stated rather than hidden:
 *   - the marker lives in process memory, so a workspace fetched into by an EARLIER process (or by
 *     the operator outside Trent, e.g. a repository they cloned themselves) reads as trusted until
 *     a network command runs in this one. A solo conversation's session taint (`provenance.ts`
 *     S1.1) does survive a restart, because the terminal's own untrusted tag lands in it;
 *   - a command outside the `NEEDS_EGRESS` vocabulary that reaches the network anyway on the local
 *     backend (`python -c "urllib…"`) is not detected; on Docker it has no network to reach;
 *   - it is coarse: after one `npm test` (which the router sends to the egress seat) every read of
 *     that workspace is untrusted. That only changes what the provenance gate holds — memory and
 *     brain writes held, `skill_manage` refused, and the `send-after-untrusted` policy rule — never
 *     an ordinary file edit.
 */
import fs from "node:fs";
import path from "node:path";

/** Bounded, like the session bindings: a long-lived process cannot grow it without limit. */
const MAX_WORKSPACES = 1024;
const NETWORK_DERIVED = new Set<string>();

/** One spelling per directory: symlinks and trailing slashes resolve to the same key. */
function keyOf(workspace: string): string {
  try {
    return fs.realpathSync(workspace);
  } catch {
    return path.resolve(workspace);
  }
}

/** Records that a network-derived command ran against `workspace`. */
export function markNetworkDerived(workspace: string): void {
  const key = keyOf(workspace);
  if (NETWORK_DERIVED.has(key)) return;
  if (NETWORK_DERIVED.size >= MAX_WORKSPACES) NETWORK_DERIVED.delete(NETWORK_DERIVED.values().next().value as string);
  NETWORK_DERIVED.add(key);
}

/** Whether anything read from `workspace` may carry bytes a network command put there. */
export function isNetworkDerived(workspace: string): boolean {
  return NETWORK_DERIVED.has(keyOf(workspace));
}

/**
 * Whether a terminal call's output is network-derived: it asked for the network, and it got one
 * (the egress seat), or it ran where nothing takes the network away (the local backend).
 */
export function isNetworkDerivedCall(wantsNetwork: boolean, usesEgressSeat: boolean, sandboxKind: "docker" | "local"): boolean {
  return wantsNetwork && (usesEgressSeat || sandboxKind === "local");
}
