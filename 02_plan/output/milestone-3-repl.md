# Milestone 3 — The REPL that talks to the fleet (task-level)

This is the milestone that makes the product real. The previous agent's REPL returned canned strings
from `generateAutonomousReply()`. That function and every path like it gets deleted, not patched.

Prerequisites: 1.1 env contract, 1.2 errors, 1.3 config, 1.4 gateway, 1.6 orchestrator, Milestone 2 doctor.

Design authority for every visual decision: `01_discovery/output/style-contract.md`.
Body text is mist, not bone. Prompt and success are pulse. Anything awaiting a human is ember.
**No emoji anywhere** — the brand book forbids it, which voids the v1 spec's metadata line format.

---

## 3.1 — Terminal capability detection
- `detectColorMode()`: `NO_COLOR` -> monochrome; `COLORTERM=truecolor|24bit` -> 24-bit;
  `TERM=*-256color` -> 256; else 16.
- **RED test:** each env combination yields the right mode, and in monochrome mode the renderer emits
  zero escape sequences while still distinguishing states by glyph (`●` running, `◆` needs approval,
  `✓` done, `✗` failed, `·` idle).
- Also detect `isTTY`. Every raw-mode call must be guarded; piped stdin has no `setRawMode`.

## 3.2 — The style module
- Token -> ANSI in all four modes, from the style contract's table. One function per role
  (`agentName`, `meta`, `success`, `needsApproval`, `error`, `dim`), never raw hex at call sites.
- Motifs: the HUD frame (dim slate border, mint corner brackets top-left and bottom-right only), the
  fading rule under section headers, the mint `▎` selection bar, the 2.4s pulse-dot breathe.
- **RED test:** snapshot the frame and rule at 80 columns; assert no line exceeds the terminal width
  and that the 16-color fallback still distinguishes all five states.

## 3.3 — Streaming render loop
- Subscribe to the orchestrator's 20-kind event bus. Map `step_start` to a live
  `● [Engineer] Reading files...` line where the dot carries STATE colour and the name carries CATEGORY
  colour. State outranks identity — an agent awaiting a human renders ember regardless of category.
- **RED test:** feed a recorded event sequence and assert the rendered transcript, including that a
  step which enters `awaiting_approval` switches its dot to ember mid-stream.

## 3.4 — Interrupt handling (the one users notice)
- Raw mode means the OS stops generating SIGINT, so byte `0x03` arrives as data. First press aborts the
  in-flight run; second press exits.
- **Branch on `signal.aborted`, never on `error.name`** — an abort carrying a reason produces an error
  whose name is not "AbortError". This is verified, not theoretical.
- **RED test:** start a stream, inject `0x03`, assert the stream stops, the process is still alive, and
  the prompt returns. Then inject `0x03` again with nothing running and assert a clean exit with code 130.
- Always restore `setRawMode(false)` on exit, including on a thrown error.

## 3.5 — Multi-line input
- **Ctrl+J (0x0A) is the guaranteed newline** and must be documented as such.
- Alt+Enter arrives as `\x1b\r`; bind it too, with a short escape-timeout to disambiguate a bare ESC.
- Shift+Enter is **indistinguishable from Enter** unless the terminal speaks the Kitty keyboard
  protocol. Push `\x1b[>1u` at start, read `\x1b[13;2u`, and **always pop `\x1b[<u` on exit** or the
  user's terminal is left broken.
- **RED test:** each byte sequence produces newline-vs-submit correctly, and the pop is emitted on exit
  even when the process throws.

## 3.6 — Slash commands, all functional
Five of the previous implementation's commands were static text: `/mcp`, `/approvals`, `/wiki`,
`/workbench`, `/traces`. Every command must read real state.
- **RED test per command:** mutate the underlying state, run the command, assert the output changes.
  A command whose output is identical before and after a state change fails the test.
- `/` opens an autocomplete dropdown filtered on the token under the cursor — not readline Tab
  completion on the whole line, which is what the old code did and why it only worked on an empty line.

## 3.7 — Budget ticker from real costs
- Sum `costCents` from real gateway usage events. Integer cents throughout; format at the edge only.
- **RED test:** three turns produce a ticker equal to the sum of the three real costs, not a constant.
  Assert the old hard-coded `0.12` and `0.04` values appear nowhere in the codebase.
- Warn at 50/80/100 percent of the configured cap, reading thresholds from config rather than literals.

## 3.8 — Approval gates that block and survive
- An approval renders as a card and **blocks input** until answered.
- It must be persisted, so a restart mid-approval still shows a pending approval rather than a
  transcript with nothing behind it. This is the sixteenth checklist item.
- **RED test:** trigger an approval, kill the process, restart, and assert the approval is still pending
  and answerable. This test fails today by design and is the whole reason Task 1.5 exists.

## 3.9 — Offline degraded banner
With no key the planner silently falls back to deterministic plans and the critic auto-passes. That
output must never be mistaken for real model output.
- **RED test:** with no key configured, the REPL prints an explicit degraded banner before the first
  turn, and every agent line is marked as degraded.

## 3.10 — Delete the canned paths
- Remove `generateAutonomousReply` and the TUI's `setTimeout` fake reply.
- **RED test:** a repository scan asserts zero matches for the canned literals and for
  `/^Trent proxy response/` outside of the tests that assert their absence.

## Done when
A real conversation with a real agent produces real streamed output, real cost, and a real approval
that survives a restart — evidenced by a transcript in `04_verification/output/`.
