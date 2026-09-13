# Tools build spec — every Hermes tool for Trent's seats

Full research report is the agent output; this is the decision record and the dependency order.

## The fork, decided
Trent's `ToolAdapter` registry is a module constant built at import with no `register()` and no
env-driven loader. The only injection path in production is the MCP bridge, which has five defects for
this purpose: it returns nothing without DATABASE_URL, the router computes tool guidance BEFORE the
merge so injected names reach the seat only when the router ranks nothing, every result is cut at
800 characters, it reconnects per call with a 30s timeout, and the API validator blocks loopback.
`read_file` cannot be built on an 800-character cap. Hermes returns 100K.

**Decision: add a ~15-line additive seam in `apps/web/lib/tools.ts` + `semantic-router.ts`** —
`registerExternalAdapters(list)` that appends to the adapters array and resets the router catalog,
plus an env loader `TRENT_TOOL_ADAPTERS_MODULE` consulted by `buildAdapterRegistry`. Own commit, own
test, nothing else in apps/web touched. The read-only rule guards against rewriting the app; a tested
registration hook that makes agents able to read files is the exception it allows.

## Hermes's twelve toolsets, and the Trent verdict
| toolset | Trent today | verdict |
|---|---|---|
| file | none for seats | build new over TerminalBackend |
| terminal | 8-command allowlist in a temp dir | build new over DockerBackend / LocalBackend |
| web | Tavily + Jina, direct fetch | adapt: route through the egress proxy |
| browser | Camofox / Steel adapters | adapt: alias Hermes names; needs a service |
| vision / image / tts | Fal mocked; voice module | build; needs a service |
| memory | memory:read internal action | adapt: add write with 2200/1375 caps |
| delegation | workRequests -> delegated steps | exists; alias delegate_task |
| cron | autonomy-scheduler | adapt: cronjob_manage over profile jobs.json |
| skills | SkillLoader/Hub/SecurityScan | adapt: skills_list / skill_view / skill_manage |
| plugins | none | build, phase 3, same seam |
| mcp | exists per company | exists; allow loopback under a flag |
| code execution | none | phase 2, terminal + RPC |

## Build order
0. `tools/approval-floors.ts` — Hermes's hardline and dangerous patterns, matched over DEOBFUSCATED
   variants (NFKC, quote/escape strip, $IFS, env unwrap, basename). Floors are checked inside
   `execute`, not only `requiresApproval`, because approvalGranted is loop-wide once granted.
1. `tools/file_ops/` — read_file, write_file, patch, search_files with Hermes's schemas. Every op runs
   through the seat's TerminalBackend. Path confinement by realpath after symlink resolution. Deny
   globs for .env*, .git/config, ~/.ssh, ~/.aws, docker.sock. Protected instruction files are
   always-approve. 2000 lines / 100K chars with next_offset.
2. `tools/terminal/` — terminal + process_manage over DockerBackend (cap-drop ALL, no-new-privileges,
   network none; bridge + egress proxy only when a command needs egress). LocalBackend MUST be
   wrapped to scrub process.env — it currently forwards everything. 50K output, 40/60 head/tail,
   spill to a file. Approval order exactly Hermes: floors -> dangerous findings merged into ONE prompt
   -> sudo / rm -r / git push / curl|sh always.
3. `tools/web/` — web_search, web_extract through the egress proxy, SSRF floors, 15K default, spill.
4. `tools/memory/`, 5. `tools/skills/`, 6. `tools/cron/`, 7. `tools/delegation/`,
8. `tools/vision/` + `tools/browser/`, 9. `tools/code_execution/`.

## Seat wiring
`config.toolsets` is read by nothing at runtime today; file_ops and terminal are labels. The wrapper
builds adapters for `toolsets - disabled_toolsets`, registers them through the seam, resets the
router catalog, and upserts each active seat's environment with the enabled scopes and the approval
floors. Each toolset registers as ONE adapter so a single catalog entry covers the family and the
top-3 router still finds it.

## Output limits
summary <= 24,000 chars (the seat prompt re-injects every prior summary). Overflow to
<profile>/cache/spillover/<id>.txt with a 1.5K preview and the path.

## The test that closes the requirement
With `toolsets: [file_ops, terminal]`, a run whose objective is "print the name field of package.json"
ends completed with a toolCalls entry from file_ops whose summary contains the real name, and one from
terminal whose stdout came from a container whose inspect shows NetworkMode=none. Today that run
records `Tool "read_file" is not allowed for this seat.`
