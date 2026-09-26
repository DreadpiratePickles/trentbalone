# Documentation

Every page in `docs/`, one line each. New here: start with [getting-started.md](getting-started.md),
then [configuration.md](configuration.md) and [security.md](security.md).

## Start

- [getting-started.md](getting-started.md): from a clone to a first conversation, including what a
  first run with no model key does.
- [configuration.md](configuration.md): `config.yaml`, the profile `.env` for secrets, profiles, and
  every setting the schema accepts.
- [doctor.md](doctor.md): `trent doctor`, the health checks it runs against real state, and its exit codes.
- [local-models.md](local-models.md): running on a model on this machine (Ollama, LM Studio, a llama.cpp
  server): the hardware tiers, `trent setup --mode local`, what to expect, the settings and the limits.
- [troubleshooting.md](troubleshooting.md): failure modes that have actually happened, each with the
  command that identifies it.

## The fleet and its work

- [fleet.md](fleet.md): the core seats, the specialist catalog, packs, custom agents, versions, and
  export to and import from other harnesses.
- [goals.md](goals.md): standing goals with a completion contract and shell quality gates that must
  pass before any model judge.
- [jobs.md](jobs.md): the concurrent-run cap and the failed-jobs view.
- [cron.md](cron.md): scheduled jobs with `trent cron`.
- [heartbeat.md](heartbeat.md): the heartbeat, `trent heartbeat`, and its checklist.
- [improve.md](improve.md): the self-improvement loop and the gates that stop it grading itself.
- [skills.md](skills.md): skills, the one store they live in, and the scan before a skill is written.
- [brain.md](brain.md): the company brain, a versioned directory of Markdown files in the profile.
- [checkpoints.md](checkpoints.md): the ledger of the agent's own writes, and rolling a turn back.

## Tools

- [tools.md](tools.md): tool disclosure, `todo`, `clarify` and `session_search`.
- [terminal.md](terminal.md): the terminal backends where agent-authored commands run.
- [browser.md](browser.md): the browser and vision toolsets.
- [media.md](media.md): the `media` toolset, local clip and transcription tools and paid image generation.
- [social.md](social.md): the `social` toolset for a social-media manager.
- [business.md](business.md): the `business` toolset: invoices, quotes, bookings and texts, behind the gate.
- [connect.md](connect.md): `trent connect`, provider credentials for the business, media and
  social toolsets, and the token store.
- [mcp.md](mcp.md): using MCP servers as tools, and serving Trent as an MCP server.

## Surfaces and protocols

- [gateway.md](gateway.md): the messaging gateway, its platform adapters, and answering approvals
  from a phone.
- [a2a.md](a2a.md): A2A and ACP, reaching Trent from another agent or an editor.
- [desktop.md](desktop.md): the Tauri desktop app that wraps the web application.

## Security and method

- [security.md](security.md): the security model: egress credential brokering, the sandbox, the
  approval model, the side-effect gate, and what is reported but not fixed.
- [development_methodology_and_coding_rulebook.md](development_methodology_and_coding_rulebook.md):
  the rulebook this repository is built under.

## Records

- [sessions/](sessions/): dated working logs, one per session.
- [superpowers/](superpowers/): design specs from planning.
