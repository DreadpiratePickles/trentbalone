---
name: obsidian-mind
description: Work in the Obsidian Mind vault/template repo or any vault built from it. Use when editing its AGENTS/Codex-guided structure, hooks, slash commands, notes, Bases, Canvases, or setup scripts.
---

# Obsidian Mind

Use this skill as the repo-specific overlay for `breferrari/obsidian-mind`. It works best together with `obsidian-second-brain` when operating on this vault template or a vault generated from it.

## Core Rule

Read the repo's `AGENTS.md` and `AGENTS.md` before editing. They define the authoritative vault workflow, folder map, and update rules.

## Use These Skills

- `obsidian-markdown` for Obsidian-flavored Markdown and wikilinks
- `obsidian-bases` for `.base` files
- `json-canvas` for `.canvas` files
- `obsidian-cli` for vault-aware reads, search, links, and properties
- `defuddle` for extracting clean markdown from web sources

## Working Pattern

- Preserve the repo's folder structure and note conventions.
- Keep notes linked and update indexes, logs, and related files together.
- Prefer the repo's own `.Codex/commands/` and `.Codex/scripts/` for lifecycle tasks.
- Treat `brain/`, `work/`, `perf/`, `org/`, `reference/`, `thinking/`, `templates/`, and `.Codex/` as first-class surfaces.
- Use `Home.md` and `vault-manifest.json` as entry points when orienting in the vault.
- When a task touches imported source material, keep raw inputs immutable and synthesize into the correct vault pages.

## Common Triggers

- Bootstrapping or upgrading an Obsidian Mind vault
- Editing vault notes, Bases, or Canvas files
- Capturing decisions, meetings, people context, or performance notes
- Updating hook scripts, slash commands, or other repo automation
- Porting the template into a new vault or local workspace
