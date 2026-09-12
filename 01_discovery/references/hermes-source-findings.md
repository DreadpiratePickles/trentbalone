# Hermes Agent — findings from reading their SOURCE (Layer 3 reference)

Repo `NousResearch/hermes-agent`, last commit 2026-09-12. 272 MB, 12,778 files.
TypeScript 475k lines, Python 315k, TSX 253k. Python is the agent and gateway; TS/TSX is the TUI,
an Electron desktop and a web dashboard. 4,094 pytest files, 1,193 vitest files.

## ADOPT — five patterns worth copying

1. **Staged installer with a versioned JSON contract, and a guaranteed result frame.**
   `--manifest` prints `{protocol_version, stages:[{name,title,category,needs_user_input}]}`.
   The decisive trick (`install.sh:3841-3848`): the stage body runs in a **subshell**, so a helper that
   calls `exit 1` only kills the subshell and the parent still emits `{"ok":false,...}`. "No frame" becomes
   impossible. Also steal `duration_ms` from their PowerShell frame and the
   `{"ok":true,"skipped":true,"reason":...}` channel for stages needing user input.

2. **Approval floors that fire BEFORE every bypass, matched over deobfuscated command variants.**
   `approval_floors.py:26` runs deny globs and hardline patterns ahead of yolo/off mode.
   `approval_detection.py:1277` generates shell-aware variants — quote stripping, `env` unwrapping,
   basename folding — so `git st""atus` and `r\m` cannot sidestep a rule. And findings are merged into
   ONE prompt so a gateway replaying with `force=true` cannot approve one check while another was hidden.

3. **Persist-before-execute in the tool round** (`turn_tool_round.py:52`). The assistant message and any
   synthetic error results are flushed to the session store BEFORE any tool runs, so a crash mid-tool
   leaves a resumable, well-formed transcript instead of dangling tool-use blocks. Cheap. Almost nobody does it.

4. **Import-light startup watchdog** (`hermes_startup_watchdog.py`). A stdlib-only daemon thread armed
   BEFORE importing the app, disarmed once the loop is live, that dumps all thread stacks and exits with
   a restart code. Its fire path performs no imports, because a wedged main thread may hold the import lock.

5. **Progressive disclosure that DEMOTES rather than hides.** Categories collapse to a names-only line
   ("nothing is ever hidden", `prompt_builder.py:1214`); compaction swaps skill bodies for a
   `[SKILL_PRUNED]` marker that reloads on demand. Paired with a trust x verdict install table where
   **`--force` cannot override a `dangerous` verdict** (`skills_guard.py:511`). Their scanner is ~110
   regex rules across 12 categories.

Honourable mentions: one pytest subprocess per FILE instead of xdist, because persistent workers
accumulate cross-file state; and a single aggregating `all-checks-pass` CI job so branch protection
needs one required check.

## AVOID — five things to do better

1. **Zero download verification.** They pipe an unpinned third-party installer straight to bash
   (`install.sh:585`), fetch a Node tarball unverified (`:1086`), and `curl | /bin/bash` a driver
   (`:2945`). No checksum, no signature, in either installer. **We pin SHA-256 on every artifact.**
2. **Two divergent installers.** Shell has 10 stages, PowerShell has 15 with different names and a
   richer frame. Their own comment concedes it only "mirrors ... closely enough".
   **We generate both from one manifest.**
3. **Their doctor exits 0 even when checks fail, and has no `--json`.** It also calls `f.result()` with
   no timeout inside an 8-thread pool, so a library ignoring its own timeout hangs the doctor.
   **Ours exits non-zero on failure, supports `--json`, and every probe carries an AbortSignal.**
4. **No cost ceiling, and `max_iterations` defaults to `sys.maxsize`** while the docstring claims 500.
   Billing is accounted but never capped. **We enforce a real step cap and a dollar ceiling in the loop.**
5. **No snapshot or golden tests** despite a vendored Ink fork with its own reconciler, hit-testing and
   mouse layer — layout and colour regressions are invisible. Their installer "tests" are largely regex
   assertions over the script's own source text. **We add golden frames and container-based e2e.**

## THE STRATEGIC GAP — Hermes has no egress credential isolation at all
Zero mitmproxy anywhere. No CA injection (`Dockerfile` installs stock ca-certificates; no
`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`). No egress allowlist. What they call a
"proxy" is a credential-ATTACHING forwarder that never mediates bodies. And
`docker-compose.yml` uses **`network_mode: host` for both services**, which defeats container network
isolation entirely.

Their actual protection is process-boundary env scrubbing (`code_execution_env.py:30`) plus SSRF
blocking on tool fetches. That is real but far weaker than credential brokering at the boundary.

**A true TLS-intercepting egress proxy, on by default, is therefore a genuine differentiator — not
parity work.** It is the single clearest place Trent can be materially safer than Hermes.

## Other implementation details worth knowing
- Their REPL is a full prompt_toolkit `Application`, and **Ctrl+C is a key binding, not SIGINT** — raw
  mode clears ISIG so the kernel path never fires. Cancellation aborts the in-flight request's sockets
  and sets a per-thread interrupt bit that fans out to concurrent tool workers and recurses into subagents.
- Streaming is line-buffered, not per-token.
- `Ctrl+J` exists specifically because Windows Terminal intercepts Alt+Enter for fullscreen.
- TUI is React 19 on a **vendored fork of Ink** with its own reconciler; terminal capability detection is
  an explicit allowlist, not probing, because unconditional enabling broke SSH and xterm.js.
- TS<->Python transport is newline-delimited JSON-RPC 2.0 over stdio, with stdout redirected to stderr so
  a stray print cannot corrupt frames.
- Config: no schema library, a plain nested dict deep-merged over YAML, hand-rolled validation, and an
  integer `_config_version` currently at **44** with table-driven migrations and a support floor.
- A profile IS a home directory, and creating one seeds a placeholder `.env` at 0600 specifically because
  otherwise "the profile silently inherited shell API keys".
- Skill budgets are CHARACTER based, no tokenizer: 100,000 char cap described as "~36k tokens".
