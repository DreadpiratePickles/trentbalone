---
name: mem0
description: Use mem0 (Claude Mem) to persist and recall trent-os architectural decisions, rejected design approaches, and open questions across sessions. TRIGGER when: starting a new phase (especially Phase 3+), user says "check Claude Mem", "what decisions were made", "log this decision", "record rejected approach", or "what can't Phase 2 break". Also trigger before designing any new module to check if a prior decision already covers it.
---

# mem0 — Persistent Architectural Memory for trent-os

mem0 stores, retrieves, and manages architectural decisions as memories with semantic search. Use it to ensure every phase builds on documented decisions instead of re-deriving them or silently contradicting them.

---

## Installation

```bash
pip install mem0ai
```

Required env vars:
```bash
ANTHROPIC_API_KEY=...   # LLM for memory extraction/synthesis
OPENAI_API_KEY=...      # Embeddings (text-embedding-3-small by default)
```

---

## Init with Claude as LLM

```python
from mem0 import Memory

config = {
    "llm": {
        "provider": "anthropic",
        "config": {
            "model": "claude-3-5-sonnet-20241022",
            "temperature": 0.1,
            "max_tokens": 2000,
            "api_key": os.environ.get("ANTHROPIC_API_KEY"),
        }
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": "text-embedding-3-small",
            "api_key": os.environ.get("OPENAI_API_KEY"),
        }
    }
}

memory = Memory.from_config(config)
```

---

## Core API

```python
# Store a decision
memory.add(
    [{"role": "user", "content": "We chose E2B as the primary sandbox provider over Daytona because E2B has a sub-2s cold start and a stable Python SDK. Daytona is the long-running fallback only."}],
    user_id="trent-architecture"
)

# Search for prior decisions on a topic
results = memory.search(
    "sandbox provider selection",
    user_id="trent-architecture",
    top_k=5
)

# Get all stored decisions
all_memories = memory.get_all(user_id="trent-architecture")

# Update a decision (when it changes)
memory.update(memory_id, "Updated rationale: ...")

# Remove superseded decisions
memory.delete(memory_id)
```

---

## trent-os Memory Namespaces

Use consistent `user_id` values to namespace by concern:

| user_id | Contents |
|---------|----------|
| `trent-architecture` | ADRs — provider selection, data model choices, API design |
| `trent-rejected` | Rejected approaches with reasons (prevents re-proposals) |
| `trent-phase0` | Phase 0 security invariants (already shipped) |
| `trent-phase1` | Phase 1 execution engine decisions (already shipped) |
| `trent-phase2` | Phase 2 money movement decisions |
| `trent-phase3` | Phase 3 infra provisioning decisions |
| `trent-open-questions` | Unresolved questions that each new phase must not silently break |

---

## Phase 3 Pre-Coding Protocol — Read Step

**Before designing any Phase 3 module**, run these searches:

```python
# 1. Check for prior Phase 3 decisions
prior = memory.search("Phase 3 infra provisioning", user_id="trent-phase3", top_k=10)

# 2. Check what Phase 1 guarantees Phase 3 depends on
constraints = memory.search(
    "per-session budget enforcement credential boundary E2B",
    user_id="trent-phase1", top_k=5
)

# 3. Check open questions that must not be broken
open_qs = memory.get_all(user_id="trent-open-questions")

print("=== Prior Phase 3 decisions ===")
for m in prior: print(m['memory'])

print("\n=== Phase 1 constraints Phase 3 inherits ===")
for m in constraints: print(m['memory'])

print("\n=== Open questions Phase 3 must not break ===")
for m in open_qs: print(m['memory'])
```

---

## Phase 1 Decisions Already Recorded

These should be loaded into mem0 once (idempotent):

```python
PHASE1_DECISIONS = [
    "Sandbox providers: E2B is primary (sub-2s start), Daytona is long-running fallback. Selection criteria: cold start latency and SDK stability.",
    "Credential boundary design: secrets are injected as env vars to sandbox processes only. They are NEVER passed to model context. The local provider explicitly strips GITHUB_TOKEN, DATABASE_URL, SECRET_ENCRYPTION_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY from exec() env.",
    "Artifact capture format: all artifacts go through provider.captureArtifact() which writes to store.addWorkbenchArtifact(). Never bypass the provider interface. Storage keys are prefixed by provider name (local/ or e2b/).",
    "Cost enforcement approach: per-session budget enforced in two places — recordSessionSpend() triggers stop when costCents >= maxCostCents, and workbenchSessionSweep() terminates sessions where costCents >= maxCostCents. Both checks must remain.",
    "Session idle reaping: workbenchSessionSweep() runs the idle reaper. IDLE_TIMEOUT_SECONDS env var controls threshold (default 600s). Stuck-starting sessions are reaped after STUCK_STARTING_SECONDS (120s).",
    "Per-company persistent workspace: companies/{companyId}/repo/ is the cached git clone. Per-session worktrees live at companies/{companyId}/worktrees/{sessionId}/. This structure must not change.",
    "Safety layer: workbench-safety.ts owns BLOCKED_PATTERNS and ALLOWED_EXECUTABLES. The allowlist is intentionally narrow. Any new executables needed for Phase 3 infra work must be added here with adversarial review.",
    "Approval gates: DEFAULT_WORKBENCH_APPROVAL_GATES includes deploy, git_push, purchase, login, secret_access. Phase 3 infra provisioning MUST add new gate types (e.g. infra_create, infra_destroy) rather than reusing existing ones.",
    "E2B sandbox registry: sandboxes Map is module-level in workbench-e2b-provider.ts. If the process restarts, the in-memory map is lost but the E2B sandbox may still be running. Phase 2/3 must handle orphaned sandboxes.",
]

for decision in PHASE1_DECISIONS:
    memory.add([{"role": "user", "content": decision}], user_id="trent-phase1")
```

---

## Rejected Approaches to Record

```python
REJECTED = [
    "Redis-backed session state for orchestration: rejected because Redis outage would block all session management. Chose DB-backed state (Prisma store) which is always available.",
    "Passing secrets in model context via tool results: rejected as P0 credential boundary violation. Secrets flow only through process.env inside the sandbox.",
    "Single workbench.ts monolith: rejected in favour of split modules (orchestrator, provider, safety, workspace, artifact-capture, browser, screenshot, preview) for isolated testability.",
    "Always-200 health endpoint: rejected because it masked DB outages from downstream load balancers. Now returns 503 when degraded (Phase 0 fix).",
]

for r in REJECTED:
    memory.add([{"role": "user", "content": r}], user_id="trent-rejected")
```

---

## Open Questions to Seed

```python
OPEN_QUESTIONS = [
    "Does the per-session budget enforcement survive a Stripe charge failure in Phase 2? If Stripe is down, can a session exceed its cost ceiling?",
    "Does the credential boundary hold if E2B is swapped for Daytona mid-session? The sandboxes Map is per-provider — a provider switch would lose the sandbox reference.",
    "The E2B provider does not run workbench-safety.ts command allowlist checks. Is this intentional? Phase 3 infra commands (terraform, pulumi, kubectl) are not in ALLOWED_EXECUTABLES.",
    "The persistent workspace (workbench-workspace.ts) stores credentials in SyncWorkspaceOptions.env as a GitEnv dict. Are these credentials ever logged to workbench events?",
]

for q in OPEN_QUESTIONS:
    memory.add([{"role": "user", "content": q}], user_id="trent-open-questions")
```

---

## After Each Phase 3 Session

Record every new decision before the session ends:

```python
def record_decision(text: str, phase: str = "trent-phase3"):
    memory.add([{"role": "user", "content": text}], user_id=phase)
    print(f"Recorded to {phase}: {text[:80]}...")
```

---

## Troubleshooting

- **Duplicate memories**: mem0 deduplicates by semantic similarity. Adding the same decision twice is safe.
- **Memory not found**: use `get_all(user_id=...)` to see everything, then `search()` with different phrasing.
- **LLM extraction wrong**: mem0 uses the LLM to extract structured facts from the messages list. Pass one clear declarative sentence per `add()` call for best results.
