# H5 browser attach, 2026-09-26

Gap 9 of `01_discovery/output/harness-landscape-2026-09-26.md` (harness-others rows "Claude in
Chrome", "Manus Browser Operator"): the `browser` toolset only launches its own headless Chromium
through the egress proxy, so it can never act in the owner's logged-in accounts. Owner: H5 (one
Opus agent, no subagents). Ownership: `packages/trent-core/src/tools/browser/**`, a
`// [H5] browser attach` block in `config/sections/tools.ts` (+ schema-split input and snapshot),
a section of `docs/browser.md`, lines of `docs/configuration.md`, this log. Others in the tree:
S2 apps/cli surfaces, H3 webhooks, L1 model-gateway/orchestrator, L2 setup, H4 gateway platforms.

## Read first
- AGENTS.md, the rulebook (failing test first; floors inside `execute`; every file under 500 lines).
- `tools/browser/{index,session,launch,page-types,schemas,chromium}.ts` and both tests;
  `browser.chromium.test.ts` is the real-Chromium pattern (skip, not pass, without a Chromium).
- The gate: `governance/bound-approvals.ts` `requireBoundApproval` (what an adapter calls inside
  `execute`; social/business do it). The wrapper chain classifies by NAME (`policy-rules.ts`
  `classifyCall`): `browser_click` is `network` + `inbound`, never on the class floor, and no
  `browser_*` name carries an idempotency token. So the attached gate must live in the adapter,
  and a grant must be made one-shot by the adapter itself (see Design).
- The allowlist the launched browser lives under is `egress.intercept_domains`, enforced by the
  proxy at CONNECT (`egress/CredentialBroker.ts` `isHostAllowed`). An attached browser does not
  go through the proxy, so the adapter must apply that same list itself.
- The audit pattern: `governance/auto-review-audit.ts` (hash-chained NDJSON in the app's
  `AuditRow` shape, `audit/export.ts` + `audit/verify.ts`).
- No doctor check is browser-related (`doctor/checks/`), so no doctor change.

## Baseline (23:54 local)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/browser packages/trent-core/src/config packages/trent-core/src/governance/idempotent-dispatch.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
-> exit 1, 1 failed / 112 passed: docs-truth "README must state the command count" expects
[36, 152], README says [35, 151]. Pre-existing (another agent's new command); not H5's to fix.

## Probe (scratchpad, not committed)
Chrome (`/Applications/Google Chrome.app`, `--headless=new --remote-debugging-port=0` on a temp
`--user-data-dir`, `--host-resolver-rules=MAP attach-probe.example 127.0.0.1`) +
`playwright-core` 1.63 `chromium.connectOverCDP`: `browser.contexts()[0].pages()` is the tab list;
`browser.close()` on a CDP-connected browser DISCONNECTS and left both tabs listed in
`/json/list` (the reused one and one it opened). -> exit 0.

## Design
- Tool vs argument: `attach: true` on `browser_navigate`. The tool count stays 12, so
  `BUILTIN_TOOL_NAMES`, the MCP toolset listing and the disclosure threshold arithmetic are
  unchanged. A navigate with `attach: true` switches the adapter to the attached tab; `attach:
  false` switches back to the launched browser; omitted keeps the current mode (launched by
  default). Every other `browser_*` tool acts on whichever is current.
- Config: `tools.browser.attach` {enabled false, cdp_url "http://127.0.0.1:9222", profile_hint?},
  NOT a top-level `browser.attach`: a top-level key needs `config/schema.ts`, which H5 does not own;
  `tools` is composed from `sections/tools.ts`. The zod schema lives beside the code that enforces
  it (`tools/browser/attach-config.ts`), composed by one marked import + one marked block, the
  `gate`/`checkpoints` pattern. `tools.browser` is OPTIONAL (absent = off), so `DEFAULT_CONFIG`
  and every existing `tools: {...}` literal keep type-checking and the defaults snapshot is
  unchanged.
- Floors in an attached session, before the gate, which no approval lifts: attach disabled ->
  blocked; `cdp_url` not loopback -> blocked; navigation passes `checkUrlSafety` AND
  `egress.intercept_domains` (`isHostAllowed`, the proxy's own function) because the proxy is not in
  the path; every later call re-checks the tab's CURRENT site against that allowlist (a click can
  leave it); `browser_type` into type=password or autocomplete current-/new-password/one-time-code
  is refused; `browser_press` with focus in such a field is refused; `browser_console` with an
  `expression` is refused (JavaScript in a logged-in page reads its cookies and tokens).
- Gate: navigate, back, click, type, press, scroll call `requireBoundApproval` inside `execute`
  with class `customer_facing`; the key args are the tool args + the site (origin+path) + the
  element's role/label + the attach session id + an occurrence counter, so an approval covers
  exactly one execution of exactly that call on exactly that page in this session (browser names
  carry no idempotency token, so without the counter one yes would click "Send" forever).
  `dryRun` stamps the row (`bindings.preview`) so a seat's step approval grants the replay, as the
  class floor does. Reads (snapshot, text, screenshot, images, vision, console read) are ungated.
  The preview names the profile hint, the site and the action (the typed text included).
- Tab choice: an EMPTY tab (about:blank / new-tab page) is reused, else a new tab is opened; a tab
  showing the owner's content is never navigated away from.
- Audit: `<profile>/browser/attach-audit.ndjson`, hash-chained `AuditRow`s (the app's shape and
  hash, `audit/verify.ts` re-walks it), mode 0600: attach, each action (site = origin + path, never
  the query, never typed text), detach.
- No proxy: CDP to loopback, and NO `x-trent-proxy-token` header on the owner's context (it would
  hand the broker token to every site the owner visits).
- Detach (`cleanup`): `browser.close()` on the CDP connection only; never `page.close()` or
  `context.close()` (closing the default context would close the owner's windows).
- Builder: `tools/index.ts` must pass `config.tools.browser.attach`, `config.egress.intercept_domains`
  and the seat into `createBrowserAdapter`, or the key is declared and never read (the curator
  `scan_agent_skills` defect). That file is outside H5's list; the edit is three marked lines.

## RED (00:02 local, 2026-09-26)
Tests written first: `tools/browser/attach.test.ts` (17, fake CDP Chrome), `attach-config.test.ts`
(7: schema, disabled default, builder wiring), `browser.attach.chromium.test.ts` (5, a throwaway
headless Chrome on a temp `--user-data-dir`, started with `--remote-debugging-port=0`).
1. `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/browser` -> exit 1:
   the three new files fail to load (`./attach-config.js`, `./attach-audit.js` not found); the two
   existing files pass 19/19. A structural red, so the two modules were stubbed to their interface.
2. Same run over the three new files -> exit 1, 23 failed / 1 passed / 5 skipped. The 5 skipped
   were a HARNESS failure ("timed out waiting for DevToolsActivePort"): headless Chrome refuses two
   start URLs ("Multiple targets are not supported in headless mode"). Not a valid red; the harness
   now starts `about:blank` and opens the owner's tab with `PUT /json/new`.
3. `npx vitest run .../browser.attach.chromium.test.ts` -> exit 1, 5 failed for the right reason:
   "browser_navigate not_available: no Chromium was found ... expected 'failed' to be
   'needs_approval'" (the adapter ignores `attach`), and after `cleanup` the tabs are
   `about:blank` + `/owner` (nothing was attached). The one test passing before implementation is
   "is off when absent" (`tools.browser` undefined today), which pins the default rather than
   proving new code.

## GREEN (00:40 local)
Implemented: `attach-config.ts` (schema + `checkCdpUrl`), `attach.ts` (`AttachedMode`: source,
floors, bound gate, one-shot counter, dryRun stamping), `attach-audit.ts` (hash chain),
`session.ts` (a `PageSource` seam: `launchedSource` + the attached one; `element`,
`assertFocusNotSecret`, `bringToFront`), `launch.ts` `createCdpConnector`, `page-types.ts`
(`contexts`/`pages`/`bringToFront`, `FieldKind`, `isSecretField`, `FOCUSED_FIELD_SCRIPT`),
`schemas.ts` (`attach` on navigate), `index.ts` (mode per navigate; requiresApproval/dryRun for
attached calls; cleanup detaches), the `// [H5]` block in `sections/tools.ts`, the schema-split
input (+ regen: the snapshot diff is exactly the new `tools.browser` block, exit 0), and three
marked lines in `tools/index.ts` (attach, `egress.intercept_domains`, seat).

Found on the way, and fixed with its own red:
- PRE-EXISTING, launched mode: the password floor was inert against a real page.
  `locator.evaluate("(el) => ...")` is evaluated by Playwright as an EXPRESSION (only a real
  function is called with the element), so the field kind came back empty and `browser_type` typed
  into `type=password`. The fake browser could not show it. Red:
  `npx vitest run .../browser.chromium.test.ts` -> exit 1, "Typed 7 character(s) into @e3.:
  expected 'completed' to be 'blocked'". Fix: `FIELD_KIND_FN = new Function("el", ...)`. Now
  pinned by "refuses to type into a real password field, and the text never reaches the page".
- A click in the attached real Chromium timed out once (10 s) under the parallel run: the reused
  tab sat behind the owner's tab, and Playwright's stability check waits on animation frames a
  background tab does not get (the likely cause; not separately proven). The attached tab is now
  brought to the front on attach and before every approved action, which is also where the owner
  should watch it. After: 3 consecutive runs of
  `npx vitest run packages/trent-core/src/tools/browser packages/trent-core/src/config` -> exit 0,
  18 files, 118 tests, each run.
- My own test-helper bug: `nav(url, undefined)` hit the default parameter and still sent
  `attach: true`; the helper now takes `null` for "omitted".

## Builder line ceiling (00:55 local)
The verify run failed `wrapped-modules.test.ts` "under the 500-line ceiling": `tools/index.ts` was
ALREADY at 500 (split length; `wc -l` 499) before H5, and the first wiring added 6 lines (506).
The mapping moved into an owned helper, `browserAttachOptions(config, seat)` in
`tools/browser/attach-config.ts`; the builder change is now net zero lines: one import name, one
marked spread line, and `profileDir: deps.profileDir, egress,` joined onto one line to pay for it.
`ToolBuildConfig` is unchanged: the helper reads `egress` structurally from the config a surface
hands the builder (the profile's `TrentConfig` in every surface).

## Attaching must not change the owner's Chrome (01:00 local)
Read in `playwright-core` 1.63 (`lib/coreBundle.js`, `types/types.d.ts`): `connectOverCDP`
initialises the DEFAULT context with `Browser.setDownloadBehavior` (allowAndName into Playwright's
temporary artifacts folder, removed on close) and enables focus emulation on its pages, unless
`noDefaults: true`, documented as "useful when attaching to a user's daily-driver browser".
Red: new `attach-connector.test.ts` (a `vi.mock` of `playwright-core`) -> exit 1, the call lacked
`"noDefaults": true`. Fixed in `createCdpConnector`. Then
`npx vitest run packages/trent-core/src/tools/browser` -> exit 0, 6 files, 50 tests (the real
attach included).

## Verify (01:05 local)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/browser packages/trent-core/src/config packages/trent-core/src/governance/idempotent-dispatch.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 23 files, 150 tests (the baseline's docs-truth README-count failure is gone: fixed by
  whoever added the command; H5 did not touch README).
- `cd packages/trent-core && npm run build` -> exit 2, ONE error, not H5's:
  `src/orchestrator/seat-constrained.test.ts(114,42): TS2353 ... 'role' does not exist`, an
  untracked file of L1's in flight. tsc reports every error, so every H5 file type-checks.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (canned 0, hex 0, emoji 0).
- Wider sweep: `npx vitest run packages/trent-core/src/tools packages/trent-core/src/mcp-server packages/trent-core/src/governance packages/trent-core/src/improve/docs-corpus.test.ts`
  -> exit 0, 76 files, 660 passed, 19 skipped (live suites).
- Largest H5-touched files: attach.test.ts 412, browser.test.ts 331, attach.ts 313, session.ts
  284; `tools/index.ts` 499 (unchanged count).

## Files
New: `tools/browser/{attach,attach-config,attach-audit}.ts`, `tools/browser/{attach,attach-config,
attach-connector,browser.attach.chromium}.test.ts`. Changed: `tools/browser/{index,session,
page-types,launch,schemas}.ts`, `tools/browser/browser.chromium.test.ts` (the pre-existing password
defect's pin), `config/sections/tools.ts` (marked import + `// [H5]` block),
`config/schema-split.input.json` + regenerated snapshot, `tools/index.ts` (OUTSIDE the H5 list:
one import name, one marked spread line, two lines joined; net zero), `docs/browser.md`
("Attach to your own Chrome" + table rows), `docs/configuration.md` (yaml lines + "Browser
attach"), this log. Nothing committed, staged, stashed or pushed.

## Open, for the lead
- `tools/index.ts` is at the 500-line ceiling exactly; the next hand to add a line there breaks
  `wrapped-modules.test.ts`. A split of the builder is due; not H5's to do.
- The attached tab is taken to the front before each approved action (the owner sees it); a Chrome
  build that ignores `Page.bringToFront` in the background was not tested.
- `trent doctor` has no browser check, so nothing reports whether a debugging Chrome is listening;
  the refusal on the first attached navigation says how to start one.
