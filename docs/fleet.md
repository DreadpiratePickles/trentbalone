# Fleet

The catalog holds 164 specialists across 13 divisions, plus 9 core seats. It is data in the wrapped
application (`apps/web/lib/agent-catalog.ts`), not prompts generated at runtime.

```bash
npm run cli -- fleet list
npm run cli -- fleet list --json
npm run cli -- fleet list --category engineering
npm run cli -- fleet list --installed
npm run cli -- fleet status
```

`fleet list --json` reports `{ count, total, agents }` with 173 agents: the 164 specialists plus the
9 core seats. `fleet status` reports the catalog size on its own:

```
FLEET STATUS
  active 4  installed 4  catalog 164
  budget 0.00 / 10.00
```

## The nine core seats

From `CORE_ROLES` in `packages/trent-core/src/fleet/AgentInstaller.ts`. Descriptions are quoted from
the source, not written for this page.

| Id | Name | Division | Does |
|---|---|---|---|
| `ceo` | CEO Agent | executive | Prioritizes strategy, roadmap, risks, and operating cycle summaries |
| `engineer` | Lead Engineer | engineering | Plans code changes, GitHub work, tests, and technical architecture |
| `growth` | Growth Hacker | marketing | Designs acquisition experiments, campaigns, and funnel improvements |
| `content` | Design & Content Lead | design | Creates design direction, landing copy, docs, and creative briefs |
| `support` | Support & Ops Responder | support | Drafts replies, mines customer feedback, and handles operations |
| `analyst` | Market & Data Analyst | product | Researches markets, competitors, and revenue metrics |
| `finance` | Finance & Treasury Lead | finance | Tracks spend, margins, budget caps, and financial runways |
| `browser` | Autonomous Web Navigator | specialized | Executes web research, scraping, and form automation |
| `escalation` | Critic & Compliance Auditor | specialized | Critiques plans and audits risk before irreversible execution |

Install them together with `fleet install core-roles --pack`.

## Divisions

Counted from `fleet list --json` on this repository. The counts cover all 173 rows, so each core seat
appears inside its division.

| Division | Agents |
|---|---:|
| specialized | 43 |
| marketing | 31 |
| engineering | 30 |
| design | 9 |
| sales | 8 |
| testing | 8 |
| support | 7 |
| paid-media | 7 |
| product | 6 |
| finance | 6 |
| project-management | 6 |
| spatial-computing | 6 |
| academic | 5 |

That totals 173. Subtract the nine core seats and the catalog is exactly 164, asserted by
`packages/trent-core/src/agents/catalog.test.ts`, which also checks the ids are unique and the
per-division head counts sum correctly.

Importing the agents wrapper runs `assertSkillsInstalled` at module evaluation time, so it also
validates that every skill the catalog references exists in `lib/data/skill-agent-map.json`. That is
a deliberate fail-fast: a catalog entry pointing at a missing skill breaks the import rather than
failing later at run time.

## Installing and deploying

```bash
npm run cli -- fleet install eng-ai-engineer
npm run cli -- fleet deploy eng-ai-engineer
```

`install` provisions the agent's tools, skills and model policy into the active profile. `deploy`
promotes an installed agent onto active duty, which is what puts it in the orchestration loop.

## Packs

```bash
npm run cli -- fleet install engineering --pack
npm run cli -- fleet install all --pack
```

Available packs: `engineering`, `marketing`, `finance`, `support`, `executive`, `eng-trio`,
`growth-engine`, `revops`, `security-audit`, `core-roles`, `all`.

`all` installs the 164 specialists. It used to be labelled "164 specialists" and install nine core
roles; the core roles are now their own pack, and a test asserts the `all` pack's agent list is
exactly 164 long and that its name contains the number it promises.

## Custom agents

```bash
npm run cli -- fleet create my-analyst \
  --name "Revenue Analyst" \
  --role analyst \
  --category finance \
  --budget 1.00
```

`--budget` is in USD at this boundary and is stored as integer cents. See
[configuration.md](configuration.md).

## Colour

An agent line renders as `● [Name]`. The dot carries state colour, the name carries division colour,
and state outranks identity: an agent waiting on a human turns ember regardless of its division. Two
divisions collide with the state signals — `marketing` is the ember hex and `product` is the pulse
hex — so those two are demoted to mist rather than being allowed to read as a state.

## Not yet implemented

- A marketplace install flow. `packages/trent-core/src/marketplace/` wraps the application's
  marketplace module but no CLI command exposes it.
