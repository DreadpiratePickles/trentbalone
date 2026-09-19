# Checkpoints and rollback

Every file Trent writes for you is recorded before it lands, so a turn can be undone byte for
byte. There is no snapshot of the workspace and no shadow repository: the record is a ledger of
the agent's own writes, and a rollback restores exactly those paths and nothing else. A file you
edited yourself is never quietly reverted — the rollback stops and names it instead.

## The ledger

One row per write, written *before* the bytes reach the file, because after the write the only
copy of the previous content is gone.

```
<profile>/checkpoints/                              0700
<profile>/checkpoints/<run_id>/ledger.jsonl         0600, append-only, one JSON row per line
<profile>/checkpoints/<run_id>/blobs/<hh>/<sha256>  0600, the pre-images, content-addressed
```

A row is:

| Field | Meaning |
|---|---|
| `run_id` | the checkpoint session: one REPL session, or one `trent run` |
| `turn` | the turn inside that session (see below) |
| `step` | the write's position inside the turn, from 1 |
| `seat` | which seat wrote |
| `tool` | `write_file`, `patch`, or `rollback` for a restore |
| `path` | POSIX path relative to the workspace root, never absolute, never traversing |
| `before_hash` | sha256 of the bytes before the write; `null` when the file did not exist |
| `before_bytes_ref` | where the pre-image lives under `checkpoints/`; `null` when there is none |
| `after_hash` | sha256 of the bytes written; `null` when the write deleted the file |
| `at` | ISO-8601 timestamp |
| `note` | present only when the row carries no pre-image and has to say why |

Two rules keep the ledger honest. A write that changes nothing records nothing, so the turn list
never claims a file was touched when its bytes are identical. And a pre-image never leaves the
profile directory, while a recorded path never leaves the workspace: both are refused at the
ledger, not at the call site, because the call site is a tool the model drives.

## Checkpoints are turns

A checkpoint is the ledger position where a turn begins — there is no second index to fall out of
step with the rows. In the REPL a turn is one submitted objective; `trent run` is a single turn.
A turn that wrote no file has no checkpoint, because there is nothing in it to undo.

## Rolling back

```
/checkpoints            the turns this session wrote files in, and what each one touched
/rollback               undo the last turn
/rollback 2             undo turn 2 and everything after it
/rollback 2 --force     … overwriting files that were edited since the agent wrote them
```

The core call behind them is `rollback({ runId, to })`, where `to` is the turn whose writes are
**kept**: `/rollback 2` is `to: 1`, and `to: 0` undoes the whole run.

What it does, in order:

1. Collapses the rows after `to` to one restore per path: the state the last recorded write left
   on disk, and the pre-image the first one captured.
2. Refuses, as a whole, if any path fails a check — nothing on disk is touched. The two refusals
   are a file whose current bytes match neither the agent's last write nor the target (something
   or someone changed it since), and a path whose pre-image the byte budget dropped.
3. Restores the remaining paths newest-touched first, write-then-rename, keeping each file's mode.
   A file the agent created is deleted.
4. Records the rollback itself in the ledger, so the undo is as auditable as the writes, and
   rolling back twice to the same turn is a no-op rather than a re-application.

`--force` overrides the drift refusal only. A pre-image that was never stored cannot be forced
back into existence.

## Configuration

```yaml
checkpoints:
  enabled: true                  # false records nothing and creates no directory
  max_bytes_per_run: 52428800    # 50 MB of pre-images per run
```

Past `max_bytes_per_run` the ledger keeps recording rows — both hashes, so the history stays
complete — but stops storing bytes, and says so in the row's `note`. Those paths are refused at
rollback rather than restored from something approximate. Turning `enabled` off is a decision that
the writes made while it is off can never be undone; switching it back on does not recover them.

## What is covered, and what is not

Covered: the `file_ops` toolset — `write_file` and `patch`, on every backend, including writes to
a file that does not exist yet.

**Not covered in this cut:** writes made by the `terminal` and `code` toolsets inside the sandbox.
A shell command can write any number of files through paths Trent never sees, so ledgering it
needs a filesystem-level observer rather than a tool hook; until that exists, `/rollback` does not
claim to undo them and they do not appear in `/checkpoints`.

Also out of scope here: one checkpoint session is open per process, because the ledger's order is
what a rollback replays and two sessions interleaving turns into one profile would produce a
history that never happened.

## Wiring

`file_ops` finds the session through the process, so a surface needs two calls and no plumbing
through the tool context:

```ts
import { openCheckpointSession } from "@trent/core/checkpoints/index.js";

const session = openCheckpointSession({ runId: sessionId, workspace, profileDir, ...config.checkpoints });
session.beginTurn(seat); // once per REPL turn; `trent run` is a single turn and may skip it
```

Until a surface opens one, nothing is ledgered and `/checkpoints` says so rather than showing an
empty list that looks like "nothing was written". `CheckpointStore` is the same surface without
the turn counter, which is what a `trent checkpoints list|rollback` command reads: it needs the
profile directory, the workspace and a run id, and nothing from the running session.
