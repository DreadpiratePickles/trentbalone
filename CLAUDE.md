# CLAUDE.md — Trent Fleet (root)

Read, in this order, before doing anything:

1. `AGENTS.md` — workspace identity and the global invariants (apps/web is read-only; failing test
   first; explicit-file staging; no push, merge, deploy or publish without authorization; no claim
   without a command and its exit code; secrets never in logs, commits, memory or chat).
2. `CONTEXT.md` — task routing to the numbered stages and the authoritative answer to common questions.
3. `docs/development_methodology_and_coding_rulebook.md` — the methodology and coding rulebook this
   repo follows (ICM stages, TDD, verification, model routing, cost discipline). Its rules override habit.

Session logs are mandatory: append `docs/sessions/YYYY-MM-DD-<topic>.md` during the session, not at
the end, and update it before context fills.

Model routing: the top model plans, decides and synthesizes; Opus subagents read, research and
implement; at most six subagents at once. The wrapped application has its own `apps/web/CLAUDE.md`.
