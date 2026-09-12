# Trent Skills Hub & Authoring

Skills are modular capability extensions for your cofounder fleet. Each skill provides custom instructions, reusable scripts, tool bindings, and optional slash commands.

---

## The Skills Hub

Browse skills available in the official catalog:
```bash
trent skills browse
```

Install a skill:
```bash
trent skills install git-release
trent skills install seo-audit
```

---

## Pre-Installation Security Scanning

Trent subjects every installed skill to an automated security audit before it is loaded:
- **High-Risk Pattern Detection**: Scans for `rm -rf /`, raw shell execution of untrusted input, credential harvesting patterns, and arbitrary curl downloads.
- **Permission Verification**: Checks required capabilities against the active workspace policy.
- **Hash Verification**: Ensures integrity against the published manifest.

If a security warning is detected, installation is blocked until explicit human approval is granted.

---

## Authoring Custom Skills

Skills live in `~/.trent/skills/<slug>/` or `.trent/skills/<slug>/` in your repository.

Each skill folder contains:
- `SKILL.md`: Metadata frontmatter and operational instructions.
- `scripts/`: Optional shell or Node scripts executed by the skill.
- `tools/`: Tool definitions exposed to agents.

### Example `SKILL.md`

```markdown
---
name: Database Migration Helper
slug: db-migrate
version: 1.0.0
category: engineering
author: Trent Engineering
slash_command: /migrate
description: Safe automated migration assistant for PostgreSQL and SQLite with dry-run rollbacks.
---

# Instructions

When invoked via `/migrate` or when schema changes are detected:
1. Inspect `prisma/schema.prisma` or migration files.
2. Generate a non-destructive dry-run preview.
3. If changes drop columns or tables, trigger the Approval Gate before applying.
```
