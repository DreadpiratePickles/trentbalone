# 2026-09-20 — A2A: `contextId` without `taskId`, and v1.0 error texts

Branch `feature/trent-fleet-v2`, HEAD c403e92 at start (working tree already carried an unrelated
edit to `docs/sessions/2026-09-19-upgrade-round.md` and an untracked `notes/`; both left alone).
Invariants held: no subagents; no commit, stash, checkout or push; nothing under `~/.hermes`
modified; no secret read (`gem.env`, `~/.hermes/auth.json`, `~/.hermes/.env` untouched — only
Python source under `~/.hermes/hermes-agent/plugins/platforms/a2a/` was read);
`TRENT_QUEUE_FALLBACK=disabled` in every shell; vitest from the repo root; no model call.

Predecessors: `docs/sessions/2026-09-20-a2a-v1-wire.md` (follow-ups 1 and 2 are this session's
task) and `docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md`.

## Goal
1. Decide, from the A2A v1.0 specification text and Hermes's client, what a message carrying a
   `contextId` and no `taskId` means when a task in that context is `input-required`; pin the
   rule with tests in both dialects.
2. A v1.0-named request's error texts name v1.0 methods and enums; 0.3.0 texts unchanged.
3. `docs/a2a.md` updated to the truth.

## Step 1 — the specification, verbatim (before any code)
Not vendored; `spec.ts` references `https://a2a-protocol.org/latest/specification/`. Fetched
2026-09-20 (`curl`, HTTP 200) and the sentences below were read from the raw page text, not a
summary. Section 3.4.3 "Multi-Turn Conversation Patterns":

> Context Continuity: Task objects maintain conversation context through the contextId field.
> Clients MAY include the contextId in subsequent messages to indicate continuation of a previous
> interaction. Clients MAY use taskId (with or without contextId) to continue or refine a specific
> task. **Clients MAY use contextId without taskId to start a new task within an existing
> conversation context.** Agents MUST infer contextId from the task if only taskId is provided.
> Agents MUST reject messages containing mismatching contextId and taskId (i.e., the provided
> contextId is different from that of the referenced Task).
>
> Input Required State: Agents can request additional input mid-processing by transitioning a
> task to the input-required state. **The client continues the interaction by sending a new
> message with the same taskId and contextId.**

Section 3.4.2 "Task Identifier Semantics": "Task IDs are server-generated when a new task is
created in response to a Message. Agents MUST generate a unique taskId for each new task they
create." Section 3.1.1 "Send Message", Behavior: "The agent MAY create a new Task to process the
provided message asynchronously or MAY return a direct Message response for simple interactions."
Section 4.1.4 `Message.taskId`: "Optional. The task id of the message. If set, the message will
be associated with the given task." The worked example under §6 ("Multi-Turn") answers an
`TASK_STATE_INPUT_REQUIRED` task with a follow-up whose message carries `"taskId": "task-uuid"`.
The topic page `topics/life-of-a-task/` agrees: "Clients optionally attach the taskId to a
subsequent message to indicate that it continues that specific task."

**Reading.** The hypothesised wording ("if contextId is provided without taskId, the server may
continue the most recent task in that context") does not exist. The specification says the
opposite: a `contextId` with no `taskId` is the client's way to START A NEW TASK in that
context, and an `input-required` task is continued only by naming its `taskId`. Continuing a
waiting task on a `taskId`-less message would silently reinterpret a request the specification
defines as "new task", and would swallow a spec-conforming client's new request whenever another
task in the same context happened to be waiting. Per the task's own rule ("if the spec says
otherwise, follow the spec and say so"): **the lifecycle is NOT changed.** A message with
`contextId` and no `taskId` creates a new task in that context in both dialects, which is what
`TaskLifecycle.begin` already does; this session pins that with tests instead of changing it.

**Hermes's side** (`~/.hermes/hermes-agent/plugins/platforms/a2a/`, v0.21.3, read only):
- Outbound (`tools.py::_send_task`, l.96-125; `a2a_call`, l.174-196): sends `SendMessage` with
  `contextId` only, never `taskId`; on `TASK_STATE_INPUT_REQUIRED` it prints "(The peer needs
  more input — answer by calling a2a_call again with context_id '…'.)". It never reads or stores
  the task id, so it cannot perform the specification's continuation.
- Inbound (`adapter.py::_prepare_task`, l.527-572): EVERY inbound message gets
  `task_id = protocol.new_task_id()` — a new task per message, in the caller's context — and the
  text is routed to the session keyed by `chat_id=context_id`. Hermes's own server therefore
  follows the specification's "new task within an existing conversation context" reading too;
  its conversations continue because Hermes keeps per-context session state, not because a task
  is continued.
- Consequence: Hermes v0.21.3 cannot answer an `input-required` task from ANY spec-conforming
  server; its follow-up starts a new task. Trent has no per-context conversational state (a
  task's run is `runner.run({objective: <last message text>})`, so even the `taskId` continuation
  runs the answer as a fresh objective). Closing that gap is a Hermes client change (send the
  task id it was given back as `taskId`, or accept a `task_id` argument) or a Trent per-context
  memory design; neither is this session's scope, and `~/.hermes` is never modified.

Also noticed, not acted on (out of scope, recorded as a follow-up): §3.4.3 "Agents MUST reject
messages containing mismatching contextId and taskId" — `TaskLifecycle.begin` currently ignores
the message's `contextId` when `taskId` names an existing task and stamps the task's own
context on it (`normalise`). A -32602 refusal would need its own RED test.

## Status log (appended during the session)
- 19:52 Baseline: `npx vitest run packages/trent-core/src/a2a` exit 0, 5 files, 41 tests.
- 19:55 Step 1 done (above): the spec says a `taskId`-less message is a NEW task; no lifecycle
  change. Plan: pin that with tests (green from the start, said so), and translate v1.0 error
  texts at the edge (RED first) in `v1.ts` + `rpc.ts` + the stream error path in `A2AServer.ts`.
- 19:58 `npx vitest run packages/trent-core/src/a2a/context-continuation.test.ts` (new file):
  7 tests, 3 failed, 4 passed. RED, in order: `SendMessage {}` answered
  `message/send requires a \`message\` ...`; `GetTask {}` answered `tasks/get requires a string "id"`;
  `CancelTask` on a finished task answered `task "…" is completed`. The three spec-rule tests and
  the "texts that name no method or enum are identical" test passed unchanged, as expected — they
  characterise existing behaviour.
- 20:00 GREEN after `v1.ts` (`toV1Error`), `rpc.ts` (v1.0 branch maps the error), `A2AServer.ts`
  (`handleStream` maps a refused v1.0 stream's error): `npx vitest run packages/trent-core/src/a2a`
  6 files, 48 tests (41 old, 7 new); no existing test file touched (`git status`).
- 20:02 `docs/a2a.md`: "Continuation by `contextId`" section added after the states paragraph;
  interop list gained "Error texts follow the dialect" and the "Known gap" entry rewritten as a
  Hermes-side gap with the spec reason and the two Hermes source locations.
- 20:05 Live check (below). Server killed, port released, spend 0.

## Design, as built
- `packages/trent-core/src/a2a/v1.ts` (+23 lines, now 236): `toV1Error(error)` — same code, same
  `data`; in the message each 0.3.0 method name (longest first, so
  `tasks/pushNotificationConfig/get` is never half-rewritten) becomes its v1.0 name via the
  inverse of the existing `V1_METHODS` table, and the lifecycle's `is <state>` phrase becomes
  `is TASK_STATE_*` via the existing `V1_STATE` table. A text naming neither is returned as the
  same object. No new vocabulary: both tables already existed for the request/result direction.
- `rpc.ts`: the v1.0 branch of `dispatchA2A` now returns `jsonRpcError(id, toV1Error(...))`
  instead of passing the 0.3.0 error through. The 0.3.0 path (`dispatchSpec`) is untouched.
- `A2AServer.ts`: `handleStream` maps the error of a refused v1.0 `SendStreamingMessage` the
  same way (it does not go through `dispatchA2A`). One line.
- `TaskLifecycle.ts`: untouched, by decision (step 1). No metadata key was added, and the test
  asserts none appears (`metadata.continuedBy` undefined) so a later change is a visible one.
- Texts now differ by dialect (v1.0 / 0.3.0): `SendMessage requires a \`message\` …` /
  `message/send requires …` (also for a refused `SendStreamingMessage`, which shares the
  constant as `message/stream` always has); `GetTask requires a string "id"` / `tasks/get …`;
  `CancelTask requires a string "id"` / `tasks/cancel …`; `task "…" is TASK_STATE_COMPLETED` /
  `… is completed` (-32002); `task "…" is TASK_STATE_COMPLETED and takes no further messages` /
  `… is completed and …` (-32004). Identical in both: -32005 `this agent accepts text parts
  only`, -32001 `no task with id "…" exists here`, the resubscribe, push and extended-card
  refusals, and `ListTasks` (already v1.0). -32601 cannot occur for a v1.0 name (the dialect IS
  the method name), so `no method "…" on this agent` is 0.3.0-only and unchanged.

## Live check — commands, in order, with exit codes (no key, no spend)
Scratch `<S>` = this session's scratchpad. Server env `env -i PATH HOME TRENT_HOME=<S>/trent-home
TRENT_QUEUE_FALLBACK=disabled` (fresh profile, no secrets file; `env | grep -ci api_key` in the
launching shell printed 0). Probe script `<S>/hermes_context_probe.py` (below) builds the message
with Hermes's own `protocol.text_message` under `HERMES_HOME=<S>/hermes-home`, so nothing under
`~/.hermes` is read for config or written.
```
lsof -nP -iTCP:7899 -sTCP:LISTEN                                                  # exit 1 (free)
env -i ... nohup npx tsx apps/cli/src/index.ts a2a serve --port 7899 --json &     # listener pid 19859
#   stdout: {"server":"a2a","port":7899,"listening":true,"runner":true}
HERMES_HOME=<S>/hermes-home ~/.hermes/hermes-agent/venv/bin/python hermes_context_probe.py http://127.0.0.1:7899/   # exit 0, 0.97 s wall
env -i ... npx tsx apps/cli/src/index.ts budget status --json                     # exit 0: "spentCents": 0, "bySurface": []
kill -TERM 19859; lsof -nP -iTCP:7899 -sTCP:LISTEN                                # exit 1 (released); ps -p 19859 exit 1 (gone)
ls ~/.hermes/a2a_audit.jsonl ~/.hermes/a2a_conversations                          # both "No such file" (Hermes home untouched)
```
Probe output, verbatim (no secrets: the scratch profile has none):
```
== SendMessage #1 -> HTTP 200, A2A-Version 1.0: task.id=task-0a87af9b-2239-43a2-9423-095570560ceb contextId=ctx-probe state=TASK_STATE_FAILED history=1 reason="every model call failed: No model provider API keys are configured for the allowed provider chain"
== SendMessage #2 -> HTTP 200, A2A-Version 1.0: task.id=task-36709c49-5822-4ae5-ae8c-d73c2229ff2d contextId=ctx-probe state=TASK_STATE_FAILED history=1 reason="every model call failed: No model provider API keys are configured for the allowed provider chain"
== same task id? False | same contextId? True
== GetTask {} -> HTTP 200: {"code": -32602, "message": "GetTask requires a string \"id\""}
== CancelTask on the failed task -> HTTP 200: {"code": -32002, "message": "task \"task-0a87af9b-2239-43a2-9423-095570560ceb\" is TASK_STATE_FAILED"}
```
What this shows, exactly: with no key the first task fails at the gateway's own no-key check
(before any provider HTTP call; ledger 0 cents), so it never reaches `input-required`, and the
second `SendMessage` with the same `contextId` and no `taskId` creates a second task in the same
context — the specification's rule, live, from Hermes's own message builder. It does NOT show the
`input-required` case (no key can park a run on a gate here); that case is covered by the tests
above with a fake runner. The two error probes show the v1.0 texts live (`GetTask`,
`TASK_STATE_FAILED`). The server log shows two `orchestration_step` jobs and nothing else.

`hermes_context_probe.py`:
```python
"""POST what Hermes's _send_task builds, twice with ONE contextId, WITHOUT going through _send_task
(which would audit/persist under HERMES_HOME). The scratch profile has no provider key, so each
run fails at the gateway's own no-key check before any provider is reached: no model, no spend."""
import json, sys, urllib.request
sys.path.insert(0, "/Users/bobbymeher/.hermes/hermes-agent")
from plugins.platforms.a2a import protocol

url = sys.argv[1]
def post(method, params, rid):
    body = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    hdrs = {"Content-Type": "application/json", "A2A-Version": protocol.PROTOCOL_VERSION}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.headers.get("A2A-Version"), json.loads(r.read().decode())

tasks = []
for i, text in enumerate(("probe one: never executed", "probe two: same context, no taskId")):
    msg = protocol.text_message(protocol.ROLE_USER, text, context_id="ctx-probe")
    assert "taskId" not in msg
    status, ver, resp = post("SendMessage", {"message": msg}, f"probe-{i+1}")
    t = resp["result"]["task"]
    tasks.append(t)
    print(f"== SendMessage #{i+1} -> HTTP {status}, A2A-Version {ver}: task.id={t['id']} contextId={t['contextId']} "
          f"state={t['status']['state']} history={len(t.get('history', []))} reason={json.dumps(protocol.extract_text(t['status']['message']))}")
print("== same task id?", tasks[0]["id"] == tasks[1]["id"], "| same contextId?", tasks[0]["contextId"] == tasks[1]["contextId"])
status, ver, resp = post("GetTask", {}, "probe-err")
print(f"== GetTask {{}} -> HTTP {status}: {json.dumps(resp['error'])}")
status, ver, resp = post("CancelTask", {"id": tasks[0]["id"]}, "probe-err2")
print(f"== CancelTask on the failed task -> HTTP {status}: {json.dumps(resp['error'])}")
```

## Verification, final (from the repo root, TRENT_QUEUE_FALLBACK=disabled)
```
npx vitest run packages/trent-core/src/a2a packages/trent-core/src/acp packages/trent-core/src/wrapped-modules.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts   # exit 0, 11 files, 77 tests
(cd packages/trent-core && npm run build)      # exit 0 (tsc --noEmit)
node scripts/ci/repo-scan.mjs                  # exit 0
wc -l packages/trent-core/src/a2a/*.ts         # max 432 (spec-transport.test.ts); context-continuation.test.ts 213, v1.ts 236, A2AServer.ts 322
```

## Files
- `packages/trent-core/src/a2a/context-continuation.test.ts` (new; error-text block RED first)
- `packages/trent-core/src/a2a/v1.ts`, `rpc.ts`, `A2AServer.ts`
- `docs/a2a.md`
- `docs/sessions/2026-09-20-a2a-context-continuation.md` (this log)
- Not touched: `TaskLifecycle.ts`, `spec.ts`, every existing test, `apps/cli/**`, `~/.hermes/**`.
  Pre-existing working-tree changes left as found: `docs/sessions/2026-09-19-upgrade-round.md`
  (modified before this session), `notes/` (untracked).
- Scratch only: `<S>/hermes_context_probe.py`, `context-probe.out`, `a2a-serve.log`, `spec.html`,
  `trent-home/`, `hermes-home/`.

## Follow-ups (not done here)
1. Spec §3.4.3 "Agents MUST reject messages containing mismatching contextId and taskId":
   `TaskLifecycle.begin` overwrites a mismatching `contextId` with the task's own. Needs a RED
   test and a -32602 refusal; one small lifecycle change.
2. Answering a Trent gate from Hermes needs a Hermes-side change (send the task id back as
   `taskId`, or accept a `task_id` argument in `a2a_call`); `~/.hermes` is not modified by Trent
   sessions, so this is an upstream request, not a Trent task. The alternative — per-context
   conversational memory in Trent so a new task in the context sees the parked question — is a
   design decision, not a translation.
3. `docs/a2a.md` "Errors" table still lists codes only; texts now differ by dialect, which the
   interop list says. A per-code text column would be the next doc pass if wanted.
