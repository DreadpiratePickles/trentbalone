# The service: `trent service`

```
npm run cli -- service install            # write the launchd agent / systemd unit; print the command that loads it
npm run cli -- service install --now      # write it and load it
npm run cli -- service status             # installed? which pid is the daemon? who holds the gateway lock? last log lines
npm run cli -- service uninstall --now    # unload it and remove the file
npm run cli -- service daemon             # what the unit runs; also fine in a terminal
```

Without it the messaging gateway, the scheduler and the heartbeat are three foreground processes
(`trent gateway start`, `trent cron start`, `trent heartbeat start`), and the assistant stops when
the laptop reboots or the terminal closes. `trent service install` hands one process to the
operating system's own supervisor: a launchd user agent on macOS, a systemd user unit on Linux.
It starts at login and is restarted whenever it exits.

## What the daemon runs

`trent service daemon [--profile <p>]` is one foreground process that runs, in this order:

1. **the messaging gateway**, when `gateway.enabled: true` in `config.yaml`. Every platform with a
   credential starts (`trent gateway setup <platform> --token <token>`), with the agent handler,
   the run-approval link to `gateway.owner` and the push alerts that `trent gateway start` wires.
   With `gateway.enabled: true` and no platform listening the daemon refuses to start (exit 3):
   you asked for a gateway and nothing would answer.
2. **the cron runner** over `<profile>/cron/jobs.json`, always (docs/cron.md). A job's `deliver`
   target and the incident alert go through the gateway's manager.
3. **the heartbeat loop**, when `heartbeat.enabled: true` (docs/heartbeat.md). Its replies go to
   `gateway.owner` through the same manager.

A part that is off is logged as skipped, not as a failure. All three share one headless runtime,
the object graph the REPL runs on (`apps/cli/src/runtime/headless.ts`); a chat message is charged
to the day's ledger as `gateway`, and cron and heartbeat runs name themselves, exactly as when they
run as separate processes. The wiring is `apps/cli/src/commands/groups/service-daemon.ts`; the
supervisor, the log, the unit files and the install paths are `packages/trent-core/src/service/`.

### Locks

The daemon holds each profile lock exactly once: `locks/gateway.lock` (taken by the gateway
manager, only when the gateway is on), `cron/runner.lock`, `heartbeat/runner.lock`, and one writer
registration `locks/writers/<pid>.lock` whose label lists `service` plus the parts running
(`service+gateway+cron`). The `service` label is how `trent service status` finds the daemon's pid
with the gateway off. Before it builds anything the daemon refuses, exit 3 naming the pid, when a
live process already holds the gateway lock (a `trent gateway start`, or a second daemon), a cron
runner, or a heartbeat loop on this profile. Run the daemon instead of those three commands, not
beside them.

### Starting and stopping

The daemon starts the parts in order; if one cannot start, the ones already started are stopped
newest first, the runtime is released, every lock is dropped, and the process exits non-zero.
SIGTERM, SIGINT (Ctrl+C) and SIGHUP stop the heartbeat, then the cron runner, then the gateway,
then release the runtime and the writer registration, and the process exits 130. Under systemd the
unit declares `SuccessExitStatus=130`, so that is a clean stop, not a failure.

## macOS: a launchd user agent

`trent service install` writes `~/Library/LaunchAgents/uk.let-trent.<profile>.plist` (mode 0644)
and prints the command that loads it; `--now` runs that command instead:

```
launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/uk.let-trent.default.plist
```

The agent has `RunAtLoad` and `KeepAlive` (started at login, restarted whenever it exits, at most
once every 30 seconds by `ThrottleInterval`), `ProcessType Background`, a `WorkingDirectory`
(the directory `install` ran in, or `--workdir <dir>`), and `StandardOutPath` /
`StandardErrorPath` under the profile's `logs/`. `ProgramArguments` is the `trent` you installed
from, by absolute path, followed by `service daemon --profile <p> --no-color` (the output lands in
a file, so no colour escapes are written into it):

| Installed from | ProgramArguments begins with |
|---|---|
| the compiled binary | the binary's resolved path |
| `npm i -g` (Node) | `node` and the resolved `dist/index.js` |
| a source checkout under tsx | `node`, tsx's `--require` / `--import` loader flags, `apps/cli/src/index.ts` |

A generated agent, with the paths shortened:

```
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>uk.let-trent.default</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/trent-cli/dist/index.js</string>
    <string>service</string>
    <string>daemon</string>
    <string>--profile</string>
    <string>default</string>
    <string>--no-color</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/work</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TRENT_HOME</key>
    <string>/Users/you/.trent</string>
    <key>TRENT_PROFILE</key>
    <string>default</string>
    <key>TRENT_QUEUE_FALLBACK</key>
    <string>disabled</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/Users/you/.trent/logs/service.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.trent/logs/service.stderr.log</string>
</dict>
</plist>
```

Stop it for this login session with `launchctl bootout gui/<uid>/uk.let-trent.<profile>` (it comes
back at the next login while the file is installed); `trent service uninstall --now` boots it out
and removes the file. `launchctl kill SIGTERM gui/<uid>/uk.let-trent.<profile>` restarts it:
the daemon releases and exits, and `KeepAlive` starts it again (no sooner than `ThrottleInterval`).

## Linux: a systemd user unit

`trent service install` writes `~/.config/systemd/user/trent-<profile>.service` (or under
`$XDG_CONFIG_HOME/systemd/user`) and prints:

```
systemctl --user daemon-reload
systemctl --user enable --now trent-default.service
```

`--now` runs them. The unit has `Type=simple`, `ExecStart=` with every argument double-quoted
(`%` and `$` escaped), `WorkingDirectory=`, one `Environment=` line per variable, `Restart=always`,
`RestartSec=10`, `SuccessExitStatus=130` and `WantedBy=default.target`. A user unit starts when you
log in; on a machine nobody logs into, `loginctl enable-linger $USER` starts your user manager at
boot. Stop it with `systemctl --user stop trent-<profile>.service`, keep it from starting again with
`systemctl --user disable trent-<profile>.service`, or run `trent service uninstall --now`, which
does both and removes the file. Its output is in the journal: `journalctl --user -u trent-<profile>`.

## Windows

There is no launchd or systemd user manager, so `trent service install` exits 3 with the manual
alternative, a Task Scheduler entry that runs the same daemon at log on:

```
schtasks /Create /TN "Trent default" /SC ONLOGON /TR "\"C:\path\to\trent.exe\" service daemon --profile default"
```

`trent service daemon` itself runs on Windows like any foreground command.

## Replacing and moving

`install` is idempotent: the same file again reports `unchanged`. A different file already
installed for the profile (you moved or upgraded `trent`, changed `--workdir`, or your PATH changed)
is refused, exit 3, until you pass `--force`; the printed next commands then boot out or restart
the running one so the new definition takes effect. `--dry-run` writes nothing and prints the file
it would write. A profile name must be 1-64 characters of letters, digits, `.`, `_` or `-`, because
it becomes part of a file name and a label.

`trent uninstall` deletes a profile but not its unit file, and it refuses while the daemon is
running (the daemon is a live writer on the profile, docs/gateway.md). Run
`trent service uninstall --now` first.

## What the unit carries

Exactly four environment variables: `TRENT_HOME` and `TRENT_PROFILE` (so the daemon opens the
profile the installer saw), `PATH` as it was at install time with relative and duplicate entries
dropped (so docker, git and the sandboxes resolve), and `TRENT_QUEUE_FALLBACK=disabled` (the
standalone contract in AGENTS.md). No secret is ever written into a unit file: the daemon reads the
profile's `.env` itself, as every surface does.

## Logs

| File | What |
|---|---|
| `<profile>/logs/service.log` | the daemon's own lines: `service starting`, each part `started` / `skipped` / `failed to start` / `stopped`, `service stopped`; each line timestamped with the daemon's pid |
| `<profile>/logs/service.log.1` | the previous `service.log`: it rotates at 1 MiB, one old file kept |
| `<profile>/logs/service.stdout.log`, `service.stderr.log` | macOS only: everything the daemon prints, including the cron and heartbeat event lines. launchd does not rotate these and neither does Trent; delete them while the service is stopped |
| the journal | Linux: everything the daemon prints (`journalctl --user -u trent-<profile>`) |

```
2026-09-25T09:00:00.000Z service[4242] service starting: profile default
2026-09-25T09:00:01.000Z service[4242] gateway started: telegram
2026-09-25T09:00:01.000Z service[4242] cron started
2026-09-25T09:00:01.000Z service[4242] heartbeat skipped: heartbeat.enabled is false
```

A daemon that cannot start (say `gateway.enabled: true` with no platform configured) is restarted
by launchd every 30 seconds and by systemd every 10, and logs its reason each time: `trent service
status` shows the last five lines, and fixing the config or running `trent service uninstall --now`
ends the loop.

## `trent service status`

```
TRENT SERVICE (profile default)
  unit      installed /Users/you/Library/LaunchAgents/uk.let-trent.default.plist
  daemon    running pid 4242 since 2026-09-25T09:00:00.000Z
  gateway   lock held pid 4242 gateway
  log       /Users/you/.trent/logs/service.log
```

followed by the last five lines of `service.log`. `--json` carries the same as `installed`,
`daemon { running, pid }`, `gateway { held, pid, label, startedAt }` and `lastLog`. The daemon
and the gateway lock are read from the profile's lock files (`packages/trent-core/src/profile/locks.ts`),
so status reports a daemon started by hand in a terminal exactly as one started by launchd.
