# 2026-09-15 — T3.3 MCP install-time scan and tool-output scrub

Branch `feature/trent-fleet-v2`, agent task from `02_plan/output/implementation-plan-backlog.md` T3.3.

## What changed
- `packages/trent-core/src/tools/mcp/scan.ts` (new): `scanMcpTools(tools)` runs `skills/SecurityScan`
  over each tool's name, description and schema `description`/`title` strings; findings carry tool
  name + categories only. `scrubMcpResult(text)` applies the telemetry secret detectors (the ones the
  T3.2 prompt redactor reuses) with numbered `[REDACTED:<kind>#n]` tokens and hit counts; PII detectors
  and the generic 40-char base64 sweep are deliberately skipped (emails are legitimate in a result; the
  sweep blanks git SHAs).
- `tools/mcp/client.ts`: every `callTool` result is scrubbed; hits logged as counts via
  `deps.redactionLog` (default `StructuredLogger({ runId: "mcp" })` on stderr).
- `tools/mcp/index.ts`: re-exports the scan module. Fixture gains `--poison` / `FAKE_MCP_POISON=1`.
- `apps/cli/src/commands/groups/mcp.ts`: `add` connects, lists, scans; findings refuse with exit 3
  naming tool + category, nothing written; `--allow-flagged` installs and records the findings under the
  top-level `mcp_flagged` key (the entry schema strips unknown keys on save and `config/schema.ts` is
  not owned by this task); `list` shows `flagged: true`; `remove` clears it; `test` reports findings.
- `docs/mcp.md`: Install-time scan and Result scrubbing sections; Not implemented narrowed.

## Evidence
- RED: `npx vitest run packages/trent-core/src/tools/mcp/scan.test.ts` → key reached the caller
  (`expected 'echo: key=sk-…' not to contain 'sk-…'`); CLI: `expected +0 to be 3` (poisoned add succeeded).
- GREEN: focused suites 28/28; whole suite 1661 pass / 27 skip; the 5 failures are
  `tools/memory/memory.test.ts` (T4.3, concurrent agent). `tsc -p apps/cli` errors are all in
  `fleet-memory/*` (T4.3 schema change), none in mcp files. `node scripts/ci/repo-scan.mjs` exit 0.

## Open
- `flagged` lives at `mcp_flagged.<name>` rather than on the entry; moving it onto the entry needs one
  optional field in `McpServerCommonSchema` (config/schema.ts), owned by another task today.
