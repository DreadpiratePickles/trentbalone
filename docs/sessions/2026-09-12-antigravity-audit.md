# 2026-09-12 — Audit of Antigravity's Trent Fleet build

## Context
Bobby revamped Trent into "Trent Fleet" (Hermes-style CLI/TUI/Desktop over the Next.js app) using Antigravity.
Task: verify Antigravity's claims against the five spec files in repo root, report what's real, and plan what to do better.
Rule captured: subagents run on Opus; Fable only orchestrates.

## Verified so far (executable evidence)
- `npx vitest run packages/trent-core apps/cli` → 16 files / 57 tests pass. `tsc --noEmit` clean for core and cli.
- Git history: 1 commit locally (original DreadpiratePickles/trent history not carried over).
- `packages/trent-core` imports only `apps/web/lib/agent-catalog.ts`; none of model-gateway/orchestrator/skill-foundry/mcp/traces/heartbeat/evals/readiness are wrapped.
- No LLM call anywhere in core or cli. REPL reply = `generateAutonomousReply()` canned strings (apps/cli/src/repl/index.ts:176).
- Desktop: standalone Vite/React on Tauri 1.6 with simulated chat (App.tsx:216) and simulated terminal (terminal.ts:75); no icons dir; no updater plugin.
- Core/CLI "build" = `tsc --noEmit`; cli bin points at dist/index.js which is never produced. install.sh writes a wrapper that runs `npx tsx` from the repo checkout (needs the clone).
- doctor --json runs 12 checks; MCP check returns "ok" with static text.
- ~/.trent already populated on this machine by Antigravity's runs.

## Agents dispatched (Opus)
core audit, cli/tui audit, desktop+docs audit, Hermes reference brief, Bleeding Edge report distillation.

## Audit results (all five Opus agents complete)
- Core: 8 of 9 required lib/ wrapper dirs missing (model-gateway, agents, marketplace, mcp, orchestrator, heartbeat, evals, readiness); traces/ wraps nothing. Real: config, sessions, personalities, governance, FixRunner, SecurityScan/SkillLoader, LocalBackend, TokenManager. Facade: setup wizard (no prompts/OAuth), all 7 non-Telegram gateway adapters (empty bodies), SSH/E2B backends, voice, updater. Egress proxy = plain HTTP forwarder, no CONNECT/TLS, forwards unauthenticated requests anywhere. Doctor mcp/cron/workbench checks hard-coded ok. Docker backend has shell injection. Skills hub = 6-item hard-coded array.
- CLI/TUI: 11/25 key behaviors real. No LLM call in REPL or TUI. --json on 3/28 commands. No multi-line input, Ctrl+C exits, no Ctrl+B, no autocomplete dropdown. 5 slash commands static text (/mcp /approvals /wiki /workbench /traces). Budget hard-coded. TUI modal keys contradict HelpModal. install.sh wrapper resolves to $HOME/apps/cli and downloads nothing. No dist/, no Bun binary, no man page. 1 test file asserting canned strings.
- Desktop: `tauri build` fails at config validation (allowlist.systemTray invalid in v1); no icons/; Cargo features mismatch allowlist; does not wrap apps/web (constraint 19); all 10 views literal data; only 1 invoke; Rust commands return literals; no xterm, no updater, no drag-drop; palette ignores web app (obsidian/ink/steel + mint/ember). apps/web `next build` passes; files match original repo 1:1.
- Hermes bar (verified from docs/install.sh): staged installer with --manifest/--stage/--json protocol, ⚕ banner, installs uv/python/node/rg/ffmpeg/playwright, wizard runs inside installer, ~60 commands, ~90 slash cmds, TUI opt-in, doctor with real --fix list, iron-proxy TLS egress (Docker-only, off by default), 28 messaging platforms, Electron desktop over `hermes serve` JSON-RPC/WebSocket on 9119. Weak spots to beat: unpinned curl|bash, heavy deps, split CLI/TUI, egress off by default, doctor hangs.
- Bleeding Edge report: no Hermes mention. Adopt: credential brokering at egress, observation masking > summarization (52% cost cut), cache-stable prefix, Code Mode past ~15 tools, SKILL.md as specialist format, per-run budget classes, server-side approval enforcement.

## Verdict
Antigravity delivered a typed, tested skeleton (~11k LOC) that passes its own tests but does not chat with a model, install off a clone, build a desktop binary, or wrap the existing platform. Grade: scaffold, not product.

## Next
Assessment delivered to Bobby; awaiting go-ahead on rebuild plan (see chat).
