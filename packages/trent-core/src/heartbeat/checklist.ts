/**
 * `<profile>/HEARTBEAT.md`: the checklist the heartbeat turn reads. Setup writes the default
 * once; the founder edits it by hand and the loop reads it fresh on every tick.
 */
import path from "node:path";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "../config/atomic-fs.js";

export const HEARTBEAT_MD = "HEARTBEAT.md";

/** The answer that means "nothing here needs the founder"; compared after trimming. */
export const NO_REPLY = "NO_REPLY";

export const DEFAULT_HEARTBEAT_MD = `# Heartbeat checklist

Trent reads this file on every heartbeat, together with the fleet-state block below it.
Edit it freely; one line per thing worth interrupting the founder for.

- Approvals waiting on the founder: name each one and how long it has waited.
- Budget above 80 percent of the cap: say how much is left and what is spending it.
- Runs that failed since the last heartbeat: the run, the reason, whether it will retry.
- Scheduled jobs whose last run failed: the job id and the failure.
- Company memory not updated for 7 days: say so, and what it is missing.
`;

/** Where the checklist lives for a profile. */
export function heartbeatChecklistPath(profileDir: string): string {
  return path.join(profileDir, HEARTBEAT_MD);
}

/** The checklist text: the profile's file, or the default when none was written yet. */
export function readHeartbeatChecklist(profileDir: string, ioOverride?: Partial<ConfigIO>): string {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = heartbeatChecklistPath(profileDir);
  return io.existsSync(file) ? io.readFileSync(file, "utf8") : DEFAULT_HEARTBEAT_MD;
}

/** Writes the default checklist when the profile has none; a file the founder edited is never touched. */
export function writeDefaultHeartbeatChecklist(profileDir: string, ioOverride?: Partial<ConfigIO>): boolean {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = heartbeatChecklistPath(profileDir);
  if (io.existsSync(file)) return false;
  if (!io.existsSync(profileDir)) io.mkdirSync(profileDir, { recursive: true });
  atomicWriteFileSync(io, file, DEFAULT_HEARTBEAT_MD, 0o600);
  return true;
}
