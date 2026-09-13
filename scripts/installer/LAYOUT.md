# `~/.trent` layout — the contract between the installer and `trent update`

Everything the installer writes lives under `$TRENT_HOME` (default `~/.trent`, must be inside
`$HOME`), plus exactly one PATH line in the user's shell rc. Nothing needs sudo.

```
~/.trent/
  bin/trent                 launcher (POSIX sh; trent.cmd on Windows). Never a symlink.
                            Reads `current` at run time and execs versions/<v>/trent.
                            Its text does not change between versions.
  current                   one line: the active version, e.g. `1.0.0`. The ONLY switch.
  versions/<v>/trent        the compiled binary for version <v> (trent.exe on Windows).
                            One directory per installed version. Nothing is ever deleted
                            by the installer; a directory it must replace is renamed to
                            versions/<v>.broken-<utcstamp>.
  staging/                  private (0700) scratch. <asset>.unverified is a download that has
                            not been checked; <asset>.verified has a matching SHA-256 and is
                            renamed (same filesystem, atomic) into versions/<v>/. Empty after a
                            successful run.
  installer/state           key=value facts shared between stages so `--stage <name>` can
                            resume: OS, ARCH, ASSET, SHATOOL, VERSION, EXPECTED_SHA, ACTION.
                            Mode 0600. Read with sed, never sourced.
  config.yaml, .env, ...    owned by the CLI (`trent setup`); the installer never touches them.
```

## Switching versions (what `trent update` must do)

1. Download + verify the new binary exactly as the installer does (signed `SHA256SUMS`,
   SHA-256 and byte-length match, verified in a private directory).
2. Rename it into `versions/<new>/trent` and `chmod 755`.
3. Run `versions/<new>/trent --version`; it must print `<new>`.
4. Atomically write `<new>` to `current`: write `current.tmp`, then `mv current.tmp current`.
   Do not overwrite `bin/trent`.

Rollback is step 4 with the previous version name. The previous `versions/<old>/` simply stays
on disk; that directory IS the `.previous` semantics. Pruning old directories is a separate,
explicit operation (`trent update --prune` or similar), never a side effect of updating.

## Invariants the tests enforce (`scripts/install.test.sh`)

- Re-running the installer on an up-to-date machine changes no byte under `~/.trent`.
- Repointing `current` at another `versions/<v>/trent` changes what `bin/trent` runs; writing
  the old name back restores it (test "layout: repointing ~/.trent/current ...").
- A requested version older than `current` is refused unless `--force`.
- The launcher fails with exit 127 and a clear message if `current` names a missing version.

## Windows

Same shape with `bin\trent.cmd`, `versions\<v>\trent.exe`, and `current`. The launcher uses
`set /p` to read `current`; the write is a temp file + `Move-Item -Force`.
