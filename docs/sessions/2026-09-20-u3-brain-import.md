# 2026-09-20 — U3: `trent brain import` (wave 1, E ingestion)

Agent task U3 of the upgrade round (`02_plan/output/upgrade-round-design.md` section 6, audit
items 1 and 2 in `01_discovery/output/harness-upgrade-audit-2026-09-19.md` section 4). Objective:
a founder drops files into the brain and seats retrieve the right chunk with a citation.

## What landed (uncommitted; the orchestrator commits)
- `packages/trent-core/src/fleet-memory/ingest/`: `chunk.ts` (heading-, page- and sheet-aware,
  1,200/150, stable `<head>#<n>` ids, table header repetition), `extract.ts` (md, txt, csv +
  dispatcher), `office.ts` + `zip.ts` + `xml.ts` (docx, xlsx on `node:zlib`, no office dependency),
  `extract-pdf.ts` (`pdftotext` first, `pdfjs-dist` fallback loaded by a non-literal dynamic
  import so a bundle never carries it), `doc-file.ts` (front matter + `<!-- trent:page N -->`
  markers), `brain-chunks.ts` (id head <-> path), `index.ts` (`ingestDocuments`, `listBrainDocs`,
  `forgetBrainDoc`, the app's `isIndexableWikiPath` blocklist), `test-fixtures.ts` (in-code PDF,
  DOCX, XLSX builders).
- `brain.ts`: `docs/`, `removeFile`, `counts.docs`. `brain-index.ts`: chunk entries for all four
  dirs, `doc` kind, citation lines `- [lease#7 #p3 | Office lease] snippet`, docs note, index
  format in the cache key. `tools/memory/brain-read.ts`: `{"id": "<chunk id>"}` returns the chunk
  with one neighbour either side and the citation. `doctor/checks/brain-import.ts`: the extractor
  line. `apps/cli/src/commands/groups/brain.ts`: `import <paths...> [--ignore]`, `docs`,
  `forget <doc>`, dry-run convention. Docs: `docs/brain.md` sections 2, 3, 6, 7; README lines.
- Dependency: `pdfjs-dist@^6.3.289` in `packages/trent-core` (Apache-2.0, pure JS, no key). The
  cheaper alternative, `pdftotext`, is preferred when on PATH but is a system install the doctor can
  only report; hand-writing a PDF text extractor (fonts, CMaps, object streams) was rejected as
  unmaintainable. Its optional `@napi-rs/canvas` lands in the lockfile; text extraction never uses it.

## Evidence
- RED first for every item (missing modules, unknown subcommands, `brain_read` without `id`).
- `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/tools/memory
  packages/trent-core/src/doctor apps/cli/src/commands/__tests__/brain.test.ts
  apps/cli/src/commands/__tests__/registry.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 50 files / 1076 tests (an earlier run saw `wrapped-modules.test.ts` name another
  agent's in-flight `skills/skill-store.ts` at 517 lines; it was back under 500 on the final run).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `npm --prefix packages/trent-core run
  build` -> exit 2 on `src/mcp-server/*.test.ts` only (untracked, another agent's task); zero
  errors in any file of this task. `node scripts/ci/repo-scan.mjs` -> exit 0.
- Live CLI on a scratch profile: import (pdf + md), docs, status, forget, log, doctor all rendered
  without emoji; forget commits `brain: forget docs/lease.md`.

## Not done, and why
- No `brain_import` tool for seats (the audit's second entry point): the CLI is the founder's
  surface this round; a seat-driven import needs the `file_ops.write` gate wave 1 is defining.
- `recall.ts` (fleet recall over runs) is unchanged: documents enter through brain recall
  (`brain-index.ts`, `recallFromBrain`), which is the function the acceptance test names and the
  block that sits in the CONTEXT tier; folding docs into the run-derived corpus would re-score
  candidates already reaching the seat (the two-corpus rule at `recall.ts:146-159`).
- Docs are absent from the stable tier's tree on purpose (a document drop must not move cacheable
  bytes); a seat discovers them through recall lines and `brain_read` by id.
