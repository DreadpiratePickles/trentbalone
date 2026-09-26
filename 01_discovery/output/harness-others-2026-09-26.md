# The other leading agent harnesses, as they exist on 2026-09-26

Compiled 2026-09-26 for the harness-landscape pass (`docs/sessions/2026-09-26-harness-landscape.md`).
Scope: Perplexity Computer first and in depth, then Gemini CLI, OpenHands, Goose, Cline / Roo Code /
Kilo Code, Cursor, Devin, Manus, Amp, Warp and Aider, then the harnesses that launched or broke out in
2026 with measurable traction. Claude Code, Codex, OpenCode, Hermes and Pi are covered elsewhere in
this pass and appear here only as reference points.

**Method and source rules.**
- Primary sources only: the vendor's own site, docs, changelog, blog, GitHub repository, or the
  GitHub REST API. Every claim carries a source key (`[P3]`, `[G5]` and so on). The source register
  at the end maps each key to exactly one URL and the date it was read. All sources were read on
  2026-09-26 (UTC).
- perplexity.ai returns HTTP 403 to scripted fetches, so its pages were read in a real browser pane.
  GitHub star counts come from `api.github.com/repos/<owner>/<repo>` at read time.
- "Not found" means the item was not in the primary pages read in this pass. It does not mean the
  feature does not exist.
- Vendor benchmark numbers are reported as the vendor states them. None of them is independently
  reproduced, and confounds are flagged where the source itself shows one.

---

## 1. Perplexity Computer (the full page)

**What it is.** Perplexity launched Computer on 2026-02-25 as "a general-purpose digital worker that
operates the same interfaces you do", pitched as a system that "creates and executes entire
workflows, capable of running for hours or even months" [P1]. It started as a Max-only product [P1].
On 2026-03-12 it opened to all Pro subscribers on web and iOS, to Enterprise, and to Slack [P4].
It then spread to Microsoft 365 (Word, Excel, PowerPoint, Outlook, Teams) on 2026-05-28 [P7], to
email on 2026-08-24 (send or forward to `computer@perplexity.com`; it replies only to the verified
sender, using that sender's connectors, permissions and memory) [P12], and to the Comet browser's
assistant [P10]. The product page lists desktop, mobile, Slack and Microsoft 365 [P2]. Eligible US
accounts that do not pay now get included turns before they have to buy credits [P16].

**How it runs a task.** The user describes an outcome. Computer "breaks it into tasks and subtasks,
creating sub-agents for execution", and those subagents do web research, document generation, data
processing or API calls to connected services in parallel ("a document is drafted by one agent while
another gathers the data it needs") [P1]. Work is asynchronous: users can "run dozens of Perplexity
Computers in parallel". When Computer gets stuck it spawns more subagents, and it "check[s] in if it
truly needs you" [P1]. "Every task runs in an isolated compute environment with access to a real
filesystem, a real browser, and real tool integrations" [P1]. Enterprise adds "every query in its own
secure sandbox" on top of SOC 2 Type II, SAML SSO and audit logs [P3].

Around the loop:
- Every thread has a context panel showing live progress, generated artifacts and credit usage [P7].
- Forking starts a new thread that keeps the previous thread's context and assets [P8].
- Side Chat (`/ask`, `/side`, `/btw`) answers questions from a read-only snapshot without disturbing
  the running task [P16].
- Cmd+K searches past Search and Computer threads [P16].
- Confirmations, clarifying questions and connector sign-ins all surface in the input box [P8].

**Background and recurring work.** Recurring tasks run "autonomously and persistently over time" [P2].
Slack users can schedule workflows ("Every Monday at 9am, pull the latest pipeline numbers...") [P4].
Scheduled automations default to GPT-5.6 Luna and subagents default to GPT-5.6 Terra [P12].

When credits run out, active tasks pause instead of cancelling, and they resume automatically once
credits return [P17]. This is the closest documented equivalent to session resumption. Perplexity
documents compaction only for the local harness ("summarizing stale context when a trajectory grows
long") [P14]. Cloud-side compaction behaviour: not found.

**Models.** At launch Computer ran "Opus 4.6 for its core reasoning engine" and routed subagents to
specialists: Gemini for deep research, Nano Banana for images, Veo 3.1 for video, Grok for fast
lightweight tasks, and ChatGPT 5.2 for long-context recall [P1]. Users can "choose specific models for
specific subtasks" [P1]. It now draws on "20+ advanced models" [P4]. Model controls since launch:
- The orchestrator can be switched mid-task. Claude Fable 5 is offered as an orchestrator [P9].
- Model Council runs 2 to 8 models independently and synthesizes where they agree and disagree [P11].
- Kimi K3 [P11] and DeepSeek V4 Pro [P12] are offered hosted in the US.
- Effort Mode is a Light / Standard / High / Ultra slider; Perplexity then picks the model and
  reasoning level, and a Custom option remains [P16].

**Tools and connectors.**
- 400+ prebuilt connectors [P4].
- Bring Your Own Connector: any remote MCP server by URL, with OAuth, API-key or open auth; admins can
  share connectors across an organization [P4].
- Local MCP servers on the Mac app, through a helper called PerplexityXPC [P21].
- A personal or project credential vault that authenticates to any API "while keeping the raw secret
  out of the agent's activity and sandbox" [P10].
- Per-tool "Always ask" approvals, with approve once, allow for the thread, or deny; recurring runs
  inherit thread-level grants [P12].
- Premium data from Statista, CB Insights and PitchBook, plus 40+ finance tools (SEC filings,
  FactSet and others) [P3].
- "Search as Code" routes search through an SDK-backed interface. Perplexity reports execution
  reliability rising from 81.9% to 92.6% at 8% lower per-task cost [P12].
- One-click website publishing to a `pplx.app` address, or to a custom domain through Vercel [P9].

**Skills.** Custom skills let users write down "how to approach that kind of work each time" [P22].
The Agent API skills format is a zip holding a `SKILL.md` with `name` and `description` frontmatter,
up to 32 MiB and 100 files. Skills load on demand through `load_skill` ("progressive disclosure")
[P20]. A public Skills Marketplace with enterprise install approval launched on 2026-09-21 [P16].

**Memory.** Brain (2026-07-13) "builds a private context graph across your sessions, connectors,
files, and past decisions, then refreshes it overnight". Every memory links back to its source, and
the user controls retention under Customize. Perplexity reports +25% answer correctness, +16% recall
and -13% cost on tasks with prior context [P9]. Brain now writes wiki pages about people, projects and
preferences in 15 languages, and a catalog of those pages is prefilled into every session [P10].
Projects (2026-08-04, replacing Spaces) add a persistent filesystem that humans and agents edit
together, a Brain scoped to the project, and connectors scoped per account [P11].

**Local and hybrid execution.** This is the part most relevant to Trent. There are three tiers.

1. **Personal Computer.** It runs on a Mac, ideally a Mac mini left on 24/7, and merges local files,
   native apps and iMessage with the cloud orchestrator [P5]. It became generally available on Mac on
   2026-05-07 [P6] and on Windows on 2026-08-04 [P11]. Safeguards: "sensitive actions require
   approval, and every session includes a full audit trail. A kill switch gives users immediate
   control" [P3]. Actions are described as "auditable and reversible" [P5].
2. **Hybrid compute on Mac** (2026-09-01). One task is split between cloud models (planning, web,
   frontier reasoning) and a local model that handles private files. It ships with three one-click
   local models: Gemma 4 E4B, Qwen3.6 35B-A3B, and a Perplexity model. It needs Apple silicon, macOS
   15 or later, and at least 24 GB of unified memory [P15]. An on-device classifier acts as a privacy
   gate: it can mask, keep local, refuse, or ask before anything sensitive leaves the Mac, and
   enterprise admins set and audit those rules [P15].
3. **Portable Computer** (2026-08-25). The whole Computer runs on the device, on an NVIDIA DGX Spark,
   with Qwen 3.8 27B or "PPLX 27B" (Qwen post-trained for this harness). NVIDIA Nemotron 3.5
   Lightning (30B) is "coming soon" [P13]. "The orchestrator, planner, tool router, scheduler, durable
   task queue, and local search index all run on device." Local work costs no credits [P13]. The
   2026-09-21 release extended it to Windows and Linux PCs with NVIDIA RTX GPUs and at least 24 GB of
   VRAM. Moving to the cloud requires approval [P16].

**Perplexity's local harness write-up** [P14] is the most detailed public account by any vendor of how
a harness should change for small models. Its stated design:
- A minimal system prompt and a small core tool set, because Qwen 3.8 27B "begin[s] to struggle beyond
  100K tokens" despite a 260K window.
- Every other capability is an on-demand skill that loads and unloads during the trajectory.
- Compaction runs when the trajectory grows long.
- The most-used MCP connectors are converted into "compact, easy-to-use command-line tools" because
  MCP tool definitions eat context.
- Self-verification is triggered either by the model or by health-monitoring hooks.
- An OS-level sandbox is always on. "If the sandbox is unavailable, the harness disables itself"
  rather than running without it.
- The orchestrator is "deterministic harness code, not an LLM".
- An **advisor tool** lets the local model consult a frontier model. A PII classifier shows the user
  exactly what would leave the device, and the advisor returns text only, with no access to tools or
  files.

Perplexity's own numbers:
- On its 53-task Local Knowledge Work Bench (to be open-sourced), Computer scores 82.6%, Pi 77.6% and
  Hermes 74.0%, all on Qwen 3.8 27B. PPLX 27B raises Computer to 85.4%.
- On BrowseComp, Computer scores 66.7% against 50.2% for Pi and 43.9% for Hermes. **Confound stated in
  the source:** Computer used Perplexity search while Pi and Hermes used Brave.
- On Terminal Bench 2.1, advisor escalation lifts Qwen from 59.6% to 73.0% at $0.415 per rollout.
  Claude Opus 5 alone reaches 82.4% at $0.65.

The write-up also says Pi and Hermes "run commands directly with the user's permissions by default"
[P14].

**Observability and governance.**
- Usage is broken down by thread and by type (text, image, video, audio) [P17], and by model for both
  individuals and admins [P9].
- An org analytics API reports credits, connectors, artifacts, skills and task durations [P8].
- Admins can set per-member credit limits [P8], plus custom roles, SCIM groups and group credit caps
  [P10].
- Numbat is an open-source monitor for coding agents: a single Go binary that collects hook-based and
  OpenTelemetry telemetry and blocks risky actions with CEL rules [P11].

**Pricing tier.** 100 credits = $1. Ask searches are free; only Computer uses credits [P17].

| Plan | Price | Credits |
|---|---|---|
| Pro | $17/month billed annually [P18] | No monthly allocation; 4,000 one-time bonus credits [P17] |
| Max | $167/month billed annually [P19] | 10,000 per month plus a 35,000 bonus [P17] |
| Enterprise Pro | not shown on the pricing page | 500 per month [P17] |
| Enterprise Max | $271/seat/month [P19] | 15,000 per month [P17] |

Typical task ranges, per the credits help page [P17]:
- Light: 100–350 credits.
- Complex: 350–950.
- Heavy: 875–2,275.
- Mega: 2,400–9,800.

The same page's summary line says light tasks use "about 15 to 70 credits", which contradicts its own
table. Auto-refill is off by default [P17].

**What makes it distinctive.**
1. Orchestration across 20+ models is the product itself. Model choice is exposed per subtask, per
   orchestrator and per effort level [P1][P9][P16].
2. The same agent is reachable from web, mobile, Slack, Microsoft 365, email, the Comet browser and a
   24/7 Mac mini, which gives it the widest set of places to start work in this survey
   [P4][P7][P12][P5].
3. It is the only vendor here that ships a harness co-designed and post-trained with a local model,
   with a user-gated escalation path and a PII gate on every outbound call [P13][P14][P15].
4. Memory (Brain) is source-linked, auditable and self-refreshing, and has a measured effect [P9].

---

## 2. The rest of the field (compact)

### Gemini CLI (Google)
- **What it is.** An Apache-2.0 terminal agent with 107,167 stars [G1]. It ships weekly stable and
  preview builds; v0.61.0 came out 2026-09-23 [G2]. Free use with a Google login allows 60 requests a
  minute and 1,000 a day [G1].
- **Session control.** Sessions resume (`gemini -r`, `/resume`). Rewind can undo the conversation
  only, the code only, or both [G7].
- **Tools, sandbox, multi-agent.** Tools come from MCP and extensions. There are five sandbox backends
  (Seatbelt, Docker/Podman, Windows native, gVisor, LXC), none on by default [G4]. Subagents are
  Markdown files in `.gemini/agents/`, can set their own model, and four are built in; remote
  subagents connect over A2A [G5][G3]. Eleven hook events include `PreCompress` [G6].
- **Local models are the gap.** The only local model is an experimental ~1 GB Gemma 3 1B classifier,
  set up with `gemini gemma setup`, that routes each request to Gemini Flash or Pro. The main model
  stays Gemini [G8][G9]. A March 2026 proposal for Ollama and OpenAI-compatible providers has no
  maintainer reply [G10].
- **Google's local path is elsewhere.** It is the Antigravity SDK (2026-09-23): Gemma 4 26B A4B on
  LiteRT-LM, or Ollama, LM Studio or vLLM through `LocalOpenAIAgentConfig`, with more than 24 GB of
  VRAM or unified memory recommended [G11].

### OpenHands (All Hands AI)
- **What it is.** The main repo is now **Agent Canvas**, "the self-hosted developer control center"
  that runs OpenHands, Claude Code, Codex, Gemini or any ACP-compatible agent across local, Docker, VM
  or cloud backends. It is MIT-licensed, at v1.24.0, with 89,170 stars [O1].
- **Engine and automation.** The engine is the Software Agent SDK, whose README badge reads SWE-bench
  77.6 [O2]. Automations run on a schedule or from webhooks [O1].
- **Safety.** Without Docker the agent has "full access to your filesystem" [O1]. The SDK adds a
  confirmation policy and a security analyzer [O6], and a stuck detector [O11].
- **Context and delegation.** Compaction is an auditable `Condensation` event [O4]. Sub-agents come
  from the Task tool set [O5] or from Markdown files, and work can be handed to an ACP agent [O12].
- **Observability.** OpenTelemetry tracing works with Laminar, MLflow or Honeycomb [O7], and there is
  per-conversation cost tracking [O8].
- **Local models.** This is the clearest documented recipe in the field: try Qwen3.6-35B-A3B first,
  serve it with LM Studio, Ollama, vLLM or SGLang, and prefix the model name with `openai/`.
  `OLLAMA_CONTEXT_LENGTH` must be at least 22,000 (32,768 recommended). Hardware is a 24 GB+ GPU or a
  Mac with 64 GB+ [O3].

### Goose (now AAIF / Linux Foundation)
- **What it is.** Goose moved from Block to the Agentic AI Foundation. It is a Rust desktop app, CLI
  and API under Apache-2.0, at v1.52.0 (2026-09-23), with 54,657 stars [GS1]. It talks to 15+
  providers, can use existing Claude, ChatGPT or Gemini subscriptions over ACP, and connects to 70+
  MCP extensions [GS1].
- **Workflows.** Recipes are shareable YAML workflows with parameters and subrecipes that can run in
  parallel [GS4]. It also has subagents, skills, plugins, hooks, custom agents, slash commands,
  editable prompt templates, a memory extension, and `AGENTS.md` / `.goosehints` [GS5]. "Custom
  distributions" let anyone ship a rebranded Goose with preset providers and extensions [GS1].
- **Safety.** There are four permission modes, including risk-based "Smart Approval" [GS7], prompt
  injection detection, and **Adversary Mode**, an independent reviewer agent that watches tool calls
  [GS6].
- **Context.** Auto-compaction triggers at 80%, with a 1,000-turn cap [GS8].
- **Local models.** Built-in llama.cpp runs in-process: Goose downloads a GGUF from Hugging Face and
  recommends one for the memory available, with "no separate server" [GS3]. It also supports Ollama,
  LM Studio, Atomic Chat, Docker Model Runner and Ramalama [GS2]. Stated limits: tool calling is
  native only for Gemma 4 and emulated through the shell otherwise; local context is typically 4K–8K;
  loading takes 30–120 s [GS3]. Models without tool calling must run with every extension disabled
  [GS2].

### Cline, Roo Code, Kilo Code (the VS Code lineage)
- **Cline: surfaces.** VS Code, JetBrains, a CLI (headless for CI), a desktop app and an SDK; 69,327
  stars [C1].
- **Cline: features.** Plan & Act, checkpoints, rules, skills, plugins, hooks, parallel research
  subagents, Kanban (parallel agents in separate git worktrees), cron scheduling, auto-approve / YOLO
  with enterprise controls, and OpenTelemetry export [C5]. ClinePass costs $9.99/month for open-weight
  models [C6].
- **Cline: local models.** They run through Ollama, LM Studio or Atomic Chat. Cline tells users to
  turn on "Use Compact Prompt" [C2]. Its blog puts that prompt at "roughly 10% the size" of the full
  one, at the cost of losing MCP tools and Focus Chain, and recommends Qwen3 Coder 30B A3B at 4-bit
  with a 262,144-token context [C3].
- **Cline Desktop.** It is "an open-source app for open-weight models". It can import sessions from
  Claude Code and Codex and continue them on an open-weight model [C4].
- **Roo Code has shut down.** The extension closed on May 15, 2026. The docs point users to ZooCode (a
  community fork) and Cline [R1], and the repo is archived at 24,298 stars [R2].
- **Kilo Code.** MIT, 27,420 stars. It runs in VS Code, JetBrains, a CLI (a fork of OpenCode), a cloud
  agent and a code-review bot [K1]. It offers 500+ models, lets users switch models mid-task, and
  charges provider rates with zero markup. Its agents are Code, Plan, Ask and Debug; its Marketplace
  carries agents, skills, MCP servers and plugins; `kilo run --auto` suits CI [K1].
- **Kilo: local models.** It supports `ollama/<model>`, LM Studio at `127.0.0.1:1234/v1` and Atomic
  Chat. Its docs warn that local models "often do not support advanced features such as prompt
  caching, computer use" [K2].

### Cursor (agent, cloud agents, Projects)
- **Cloud agents.** "Cloud Agents were formerly called Background Agents". They run "in isolated VMs
  in the cloud", as many in parallel as wanted [CU3].
- **Projects (2026-09-10).** A coordinator agent "doesn't write code itself" but delegates to many
  agents, keeps shared context files synced across cloud and local machines "over months of work",
  and subscribes to Slack channels, PRs, CI or schedules so it can act without a prompt [CU2][CU1].
- **Self-hosted machines (2026-09-02).** Tool execution can run on the customer's own network while
  Cursor still runs inference and planning [CU7].
- **Extension and safety.** Rules, skills, subagents, hooks, plugins, MCP, and a CLI with ACP and a
  headless mode [CU6]. A terminal sandbox restricts file and network access [CU5].
- **Local models are effectively unsupported.** "All requests are routed through Cursor's servers for
  final prompt building", and custom keys "only work with chat models" [CU4]. A model on localhost is
  therefore not reachable without exposing it. First-party local-model docs: not found.

### Devin (Cognition)
- **Surfaces.** Cloud sessions on VMs (Linux, macOS with the iOS Simulator, Windows, Android
  emulator), a local Devin CLI with `/handoff` to the cloud, SSH into cloud sessions, self-hosted
  "Outposts", and ACP integrations for JetBrains, Zed and Xcode [D1].
- **Memory and customization.** Knowledge, `AGENTS.md` (only the first 16 KiB is injected
  automatically [D5]), `SKILL.md` skills, playbooks and plugins [D1].
- **Orchestration.** Dynamic Workflows run many sessions from a deterministic Python script and can
  resume a run where it stopped [D6].
- **CLI sandbox.** The CLI's `--sandbox` fails closed (the CLI refuses to start rather than run
  unsandboxed). Linux needs `bubblewrap`; Windows is unsupported; network filtering is "unstable" [D4].
- **Models.** Anthropic, OpenAI, Google and Cognition models, plus hosted DeepSeek, Kimi and GLM. The
  recommended "Fusion" option pairs a frontier lead model with a cheaper sidekick [D2]. Local models:
  not found.
- **Pricing.** Free, Pro $20, Max $200, Teams from $80/month [D3].
- **Proof of work.** After opening a PR, Devin sends video recordings that show its end-to-end test
  [D8].

### Manus
- **Ownership turbulence.** Manus "formally resumed independent operations" on 2026-09-01 [M1]. That
  followed a regulatory transition in which data some users generated after 2025-12-29 was deleted on
  August 23–24 and then restored from backups [M2].
- **Where it runs.** Each task gets a cloud virtual computer with internet, a persistent filesystem,
  and the ability to install software [M8]. The desktop "My Computer" feature works on local folders
  with per-command Allow Once / Always Allow approval and folder-scoped access [M5].
- **Parallelism.** Wide Research deploys "hundreds of independent agents", each with a fresh context
  [M7]. Branch forks a session that inherits all context up to that point [M6].
- **Other features.** Projects, Skills, scheduled tasks, Mail Manus, a cloud browser, a Browser
  Operator extension that uses the user's own signed-in browser, MCP connectors, Zapier, and an API
  [M3].
- **Pricing and models.** Pricing is credit-based (Free, Pro, Team), with usage history in a dashboard
  [M4]. Local models: not found.

### Amp
- **Orbs.** Amp now centres on Orbs: a remote machine per thread that "goes to sleep" when idle, costs
  nothing while asleep, and wakes with its files and services intact [A5]. Orbs bill per minute and
  pause 5 minutes after the agent stops [A4].
- **Coordination.** Puck is a personal assistant that starts, monitors and messages agents from the
  web, the TUI, iOS or Slack [A6]. It also offers agent-to-agent delegation, automations, plugins,
  skills, MCP, `AGENTS.md`, and TypeScript and Python SDKs [A1].
- **The Dial.** Low / medium / high / ultra is fixed per thread, because switching models or prompts
  mid-thread "invalidates the prompt cache" [A3].
- **Local models.** Model Routing accepts any OpenAI- or Anthropic-compatible endpoint through a
  "Custom URL" connection. That option is "experimental and in early access for Megawatt, Gigawatt,
  and Enterprise customers only" [A2]. Whether it accepts localhost is not documented.

### Warp
- **What it is.** Warp's client is now open source (AGPL, with the UI crates under MIT) and has 65,161
  stars. "OpenAI is the founding sponsor" [W1]. It hosts its own agent or third-party CLI agents such
  as Claude Code, Codex and OpenCode [W4].
- **Agent features.** Agent profiles and permissions, `AGENTS.md` / `WARP.md` rules, skills, MCP,
  computer use, conversation forking, and a research-preview agent memory [W4].
- **Local models are deliberately hard.** A custom inference endpoint must be public HTTPS:
  "`localhost`, `127.0.0.1`, and other private or local network URLs are rejected" because requests
  pass through Warp's backend. Cloud agents cannot use custom endpoints, and auto routing still spends
  Warp credits [W2]. Warp's Ollama guide tunnels through `ngrok` and suggests Llama 3.2 3B, Llama 3.1
  8B or Codestral 22B [W3].

### Aider
- **Status.** Aider pioneered repo-map context, automatic git commits, and linting and testing after
  each edit [AI5]. Maintenance has slowed: the last PyPI release was 0.86.2 on 2026-02-12 [AI2], the
  last commit was on 2026-05-22 [AI1], and the homepage still recommends Claude 3.7 Sonnet [AI5].
- **Local models.** Its local-model handling remains a reference. With `ollama_chat/<model>`, Aider
  sizes Ollama's context to each request plus 8K, because Ollama defaults to 2K and "silently discards
  context that exceeds the window" [AI3]. LM Studio works through `lm_studio/<model>` with a dummy key
  [AI4]. MCP, subagents and hooks: not found.

### 2026 launches and breakouts with real traction
The traction source is a GitHub search of repos created after 2026-01-01 with more than 8,000 stars
[N9]. Most of the top results are skills or context packs, not harnesses. The harnesses are:

- **DeepSeek Harness (`dsh`)**
  - Traction: created 2026-08-13, 236,019 stars, MIT, "developer preview" with breaking changes
    promised [N1].
  - What it is: an "everything-is-a-plugin" architecture on Cordis with hot reload, a web UI, a Python
    SDK and scheduled reminders [N1][N4].
  - Memory: through opt-in third-party MCP servers [N5].
  - Local models: a "Custom model API" takes any base URL speaking OpenAI Chat Completions, OpenAI
    Responses or Anthropic Messages, with model discovery [N2]. No local-runtime guidance was found.
  - Safety: its own safety notice says the sandbox "do[es] not guarantee isolation" [N3].
- **OpenClaw**
  - Traction: 390,522 stars. The repo was created 2025-11-24, so its breakout falls in 2026 but it is
    not strictly a 2026 launch. It is governed by the OpenClaw Foundation, a 501(c)(3) [N6].
  - What it is: a local Gateway daemon that brings the assistant to 20+ chat channels (WhatsApp,
    iMessage, Telegram, Slack...), with apps for five operating systems. "Tools run on the host for
    the main session unless you configure sandboxing" [N6].
  - Local models: the strongest open-source story here. A managed llama.cpp server picks a model for
    the hardware (64K-context recipes, 8 GiB floor) and verifies downloads. LM Studio (Responses API),
    Ollama, vLLM, SGLang and MLX also work, and a hosted primary can fall back to a local model. The
    docs add the caveat that "local models do not provide hosted providers' safety filters" [N7].
- **Odysseus**
  - Traction: created 2026-05-31, 87,601 stars, AGPL [N8].
  - What it is: a self-hosted workspace combining chat and agents, deep research, documents, email,
    notes, calendar and scheduled agent tasks [N8].
  - Local models: its "Cookbook" gives hardware-aware model recommendations, downloads and serving.
    It runs CPU-only under Docker and advises GGUF Q4 on llama.cpp for 8 GB GPUs before trying vLLM
    [N10].

Reference points, not profiled here: Hermes Agent at 248,979 stars [N11], OpenCode at 210,073 [N12],
Pi at 109,367 [N13].

---

## 3. Comparison table

The table is split into two halves for width. Rows are the same in both halves.

**Part A: execution, tools, safety, agents, memory**

| Harness | Execution model (sessions, compaction, background, resumption) | Tools and MCP | Sandbox and permissions | Multi-agent | Memory and instruction files |
|---|---|---|---|---|---|
| Perplexity Computer | Cloud tasks running hours to months; recurring and scheduled work; fork; Side Chat; paused tasks auto-resume when credits return [P1][P2][P8][P16][P17]. Cloud compaction not found; the local harness compacts [P14] | 400+ connectors; custom remote MCP; local MCP on Mac; credential vault; Always-ask per tool [P4][P21][P10][P12] | Isolated environment per task; approvals, audit trail, kill switch; local sandbox fails closed [P1][P3][P14] | Automatic subagents, dozens of Computers in parallel; Model Council [P1][P11] | Brain self-improving memory; Projects with a shared filesystem [P9][P11] |
| Gemini CLI | Resume, rewind, checkpointing; `PreCompress` hook [G7][G6] | Built-in files, shell and web fetch; MCP; extensions [G1][G3] | 5 sandbox backends, off by default; policy engine; trusted folders [G4][G3] | Markdown subagents; A2A remote agents [G5][G3] | `GEMINI.md` hierarchy [G3] |
| OpenHands | Agent Server REST API; condensation events; scheduled and webhook automations [O1][O4] | Terminal, editor, task tracker; MCP [O2][O9] | Docker, Apptainer or none; confirmation policy plus security analyzer [O1][O6] | Task tool sub-agents; delegate to ACP agents [O5][O12] | Persistent two-tier memory; skills [O10][O9] |
| Goose | Session resume and search; auto-compact at 80%; max 1,000 turns [GS8] | 70+ MCP extensions [GS1] | 4 permission modes; prompt-injection detection; Adversary Mode [GS7][GS6]. OS sandbox not found | Subagents sequential or parallel; parallel subrecipes [GS5][GS4] | `AGENTS.md`, `.goosehints`, memory extension, persistent instructions [GS5] |
| Cline | Plan & Act, checkpoints, headless CLI, cron schedules [C5] | Files, terminal, browser; MCP [C1][C5] | Approval per action; auto-approve / YOLO with enterprise controls; MCP allowlist [C5] | Research subagents; Kanban with worktrees; SDK teams [C5] | Rules; Memory Bank [C5] |
| Roo Code | Shut down 2026-05-15 [R1] | — | — | — | — |
| Kilo Code | Code / Plan / Ask / Debug agents; mid-task model switch; `kilo run --auto`; cloud agent [K1] | Terminal, browser; MCP via Marketplace [K1] | Permission prompts with deny rules [K1] | Custom agents [K1]; parallel not found | Not found |
| Cursor | Local agent; cloud agents in VMs; Projects over months with event subscriptions [CU3][CU2] | MCP; plugins [CU6] | Terminal sandbox; self-hosted machines [CU5][CU7] | Subagents; coordinator delegating to many agents [CU6][CU2] | Rules, skills; Project shared-context files [CU6][CU2] |
| Devin | Cloud VM sessions; CLI with cloud handoff; SSH; Outposts [D1] | IDE, browser, shell, computer use; MCP marketplace [D1] | Cloud VM; CLI sandbox fails closed [D4] | Parallel managed sessions; Dynamic Workflows [D1][D6] | Knowledge, `AGENTS.md` (16 KiB), skills, playbooks [D1][D5] |
| Manus | Cloud virtual computer; Branch; scheduled tasks [M8][M6][M3] | Cloud browser, Browser Operator, MCP, Zapier, API [M3] | Cloud sandbox; local folder-scoped, per-command approval [M5] | Wide Research with hundreds of parallel agents [M7] | Projects; Skills [M3] |
| Amp | Threads; Orbs sleep and wake with state; mode fixed per thread [A5][A3] | Tools, MCP, plugins, skills [A1] | Isolated Orb per thread [A5] | Agent-to-agent; Puck coordinator [A1][A6] | `AGENTS.md` [A1] |
| Warp | Terminal ADE agent; Oz cloud agents; forking [W4] | Terminal, codebase context, computer use; MCP [W4] | Agent profiles and permissions [W4] | Hosts third-party CLI agents [W4] | `AGENTS.md` / `WARP.md`; agent memory (preview) [W4] |
| Aider | Git-centric chat; auto-commits; lint and test [AI5] | MCP not found | Git undo; sandbox not found | Not found | Not found |
| DeepSeek Harness | Web UI sessions, plans, delegation; scheduled reminders [N4] | MCP client [N5] | Permission-policy approvals; "no guaranteed isolation" [N4][N3] | Delegation [N4] | Third-party memory MCP (opt-in) [N5] |
| OpenClaw | Local Gateway daemon for sessions, tools, events [N6] | Tools, skills, plugins, ClawHub [N6] | Host execution unless sandboxing configured; DM pairing [N6] | Not verified | State and memory on the user's hardware [N6] |
| Odysseus | Self-hosted workspace; scheduled agent tasks [N8] | Tools, MCP, shell [N8] | Auth required when exposed [N8] | Not found | Memory [N8] |

**Part B: extensibility, local models, cost, distribution, distinctive feature**

| Harness | Extensibility (hooks, plugins, recipes, skills) | Local model support (mechanism; recommended models; limits) | Observability and cost | Distribution | One distinctive feature |
|---|---|---|---|---|---|
| Perplexity Computer | Custom skills; Skills Marketplace; SKILL.md loaded via `load_skill` [P22][P16][P20] | Proprietary. Portable: Qwen 3.8 27B or PPLX 27B, on-device, DGX Spark or RTX with 24 GB+ VRAM. Hybrid Mac: Gemma 4 E4B, Qwen3.6 35B-A3B or a PPLX model, 24 GB+. No bring-your-own local model; one-click only [P13][P15][P16] | Per-thread and per-model usage; analytics API; 100 credits = $1 [P17][P9][P8] | Web, iOS, Android, Mac, Windows, Slack, Teams, M365, email; Pro $17 / Max $167 per month annual [P4][P7][P12][P18][P19] | Local model with a gated frontier "advisor" and a PII gate [P14] |
| Gemini CLI | Extensions; 11 hook events; skills; plan mode [G3][G6] | Main model must be Gemini. Local Gemma 3 1B is a router only (experimental). Google's local option is the Antigravity SDK [G8][G11] | Telemetry; free 60 rpm / 1,000 rpd [G3][G1] | npm, Homebrew, MacPorts; Apache-2.0 [G1] | Rewind: conversation, code, or both [G7] |
| OpenHands | Plugins bundling skills, hooks, MCP, agents and commands [O9] | `openai/<model>` against LM Studio, Ollama, vLLM or SGLang. Recommends Qwen3.6-35B-A3B; context 22K minimum, 32K advised; 24 GB GPU or 64 GB Mac [O3] | OpenTelemetry (Laminar, MLflow, Honeycomb); cost metrics [O7][O8] | npm, Docker, SDK, Cloud; MIT [O1] | Agent Canvas runs any ACP agent on any backend [O1] |
| Goose | Recipes, skills, plugins, hooks, slash commands, prompt templates, custom distros [GS4][GS5][GS1] | Built-in llama.cpp with HF GGUF and a memory-based pick; also Ollama, LM Studio, Docker Model Runner, Ramalama. Native tool calls only on Gemma 4; 4K–8K context [GS3][GS2] | Live token-usage indicator [GS8] | Desktop (3 OSes), CLI, API; Apache-2.0; AAIF [GS1] | Adversary Mode reviewer agent [GS6] |
| Cline | Skills, plugins, hooks, rules [C5] | Ollama, LM Studio, Atomic Chat. Compact prompt (~10%, drops MCP). Qwen3 Coder 30B A3B at 4-bit; Desktop app built for open-weight models [C2][C3][C4] | OpenTelemetry export; ClinePass $9.99 [C5][C6] | VS Code, JetBrains, CLI, Desktop, SDK [C1] | Imports Claude Code / Codex sessions [C4] |
| Roo Code | — | — | — | Archived [R2] | — |
| Kilo Code | Marketplace for agents, skills, MCP, plugins [K1] | `ollama/<model>`, LM Studio, Atomic Chat. Warns local models lack prompt caching and computer use [K2] | Zero-markup provider pricing [K1] | VS Code, JetBrains, CLI, cloud; MIT [K1] | 500+ models with mid-task switch [K1] |
| Cursor | Hooks, plugins, skills, rules [CU6] | Effectively none: requests route through Cursor servers; custom keys work for chat only [CU4] | Team analytics [CU6] | IDE, web, mobile, CLI [CU7][CU6] | Projects coordinator with subscriptions [CU2] |
| Devin | Plugins, playbooks, skills, automations [D1] | Not found. Hosted open models (DeepSeek, Kimi, GLM) only [D2] | ACU limits; Session Insights; Pro $20 / Max $200 [D1][D3] | Web, CLI, Devin Desktop, ACP IDEs, Slack, Teams [D1][D3] | Video recordings proving tests [D8] |
| Manus | Skills, custom MCP [M3] | Not found | Credit dashboard [M4] | Web, desktop, mobile, email, Slack [M3][M1] | Branch: fork with full context [M6] |
| Amp | Plugins, skills, SDKs [A1] | Custom URL endpoint in early access for top tiers only; localhost undocumented [A2] | No markup on provider prices; Orbs per minute [A4] | Web, macOS, iOS, CLI [A1] | Orbs that sleep for free [A5] |
| Warp | Skills, rules, MCP [W4] | Public HTTPS endpoint only; localhost rejected; ngrok for Ollama; Llama 3.2 3B / 3.1 8B / Codestral 22B [W2][W3] | Monthly credits; free tier needs BYOK [W4] | Desktop; AGPL client [W1] | Terminal hosting any CLI agent [W4] |
| Aider | Not found | `ollama_chat/` with auto-sized `num_ctx`; `lm_studio/` [AI3][AI4] | Not verified | pip; last release 2026-02-12 [AI2] | Repo map plus auto-commit [AI5] |
| DeepSeek Harness | Everything is a Cordis plugin, with hot reload [N1] | Custom base URL (OpenAI chat / responses, Anthropic). No runtime guidance [N2] | Not found | `npx @deepseek-ai/dsh web`; MIT [N1] | Plugin-only architecture [N1] |
| OpenClaw | Plugins, skills, ClawHub [N6] | Managed llama.cpp, hardware-aware, 64K context, 8 GiB floor; Ollama, LM Studio, vLLM, SGLang, MLX; hosted-to-local fallback [N7] | Not verified | Installer, npm, 5-OS apps; MIT; Foundation [N6] | Assistant inside 20+ chat channels [N6] |
| Odysseus | Skills, MCP [N8] | Cookbook: hardware-aware downloads and serving via llama.cpp, vLLM or SGLang; CPU-only in Docker [N10] | Not found | Docker compose; AGPL [N8] | All-in-one self-hosted workspace [N8] |

---

## 4. Distinctive features across the field (15)

1. **Per-subtask multi-model orchestration with a switchable orchestrator.** Perplexity Computer.
   https://www.perplexity.ai/changelog/brain-faster-computer-models-website-publishing
2. **Gated frontier "advisor" for a local model, with a PII classifier previewing what leaves the
   device.** Perplexity Portable Computer.
   https://www.perplexity.ai/hub/blog/a-local-first-agent-for-private-and-cost-effective-knowledge-work
3. **Connectors rewritten as compact CLI tools plus on-demand skills, to fit small-model context.**
   Perplexity Portable Computer. Same URL as item 2.
4. **Brain: source-linked, self-refreshing memory that writes wiki pages about people and projects.**
   Perplexity Computer.
   https://www.perplexity.ai/changelog/role-based-access-controls-api-credentials-and-brain-for-max
5. **Email as an agent surface (`computer@perplexity.com`), replying only to the verified sender with
   their own connectors.** Perplexity Computer.
   https://www.perplexity.ai/changelog/computer-in-email-gpt-5-6-terra-luna-and-grok-4-6
6. **Rewind that restores the conversation only, the code only, or both.** Gemini CLI.
   https://geminicli.com/docs/cli/tutorials/session-management/
7. **One control center that runs OpenHands, Claude Code, Codex or any ACP agent across local, VM and
   cloud backends.** OpenHands Agent Canvas. https://github.com/OpenHands/OpenHands
8. **Custom distributions: ship your own branded Goose with preset providers and extensions.** Goose.
   https://github.com/aaif-goose/goose
9. **Adversary Mode: an independent reviewer agent silently watching tool calls.** Goose.
   https://goose-docs.ai/docs/guides/security/
10. **Import a Claude Code or Codex session and continue it on an open-weight model.** Cline Desktop.
    https://docs.cline.bot/usage/cline-desktop.md
11. **A coordinator agent that delegates to many agents over months and subscribes to Slack, PR, CI
    and schedule events.** Cursor Projects. https://cursor.com/docs/agent/projects.md
12. **Video recordings of end-to-end tests as proof of work.** Devin.
    https://docs.devin.ai/work-with-devin/testing-and-recordings.md
13. **Branch: fork a session with its full context and files, leaving the original untouched.** Manus.
    https://manus.im/blog/manus-branch
14. **Orbs: per-thread remote machines that sleep at zero cost and wake with state.** Amp.
    https://ampcode.com/docs/markdown/orbs
15. **The assistant lives inside 20+ consumer chat channels (WhatsApp, iMessage, Telegram...).**
    OpenClaw. https://github.com/openclaw/openclaw

Also notable but outside the fifteen:
- Wide Research's hundreds of parallel agents (Manus): https://manus.im/docs/features/wide-research.md
- Numbat, an open-source monitor for coding agents with CEL block rules (Perplexity):
  https://www.perplexity.ai/changelog/shared-workspaces-personal-computer-for-windows-and-model-council
- Credits that pause tasks rather than cancel them (Perplexity):
  https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity
- Aider's automatic Ollama context sizing: https://aider.chat/docs/llms/ollama.html

---

## 5. Local models across the field

**Best local-model stories, ranked.**

1. **Goose.** It is the only mainstream open-source harness with **in-process** llama.cpp. It
   downloads a GGUF from Hugging Face, recommends a model for the memory available, and needs no
   server or port. It also supports Ollama, LM Studio, Atomic Chat, Docker Model Runner and Ramalama.
   It is honest about limits: tool calls are native only on Gemma 4 and shell-emulated otherwise, with
   4K–8K context and a 30–120 s cold load.
   https://goose-docs.ai/blog/2026/04/24/use-goose-with-built-in-local-inference/
   https://goose-docs.ai/docs/getting-started/providers
2. **OpenClaw.** A managed llama.cpp server picks a model for the hardware and verifies the download
   (curated recipes at 64K context, 8 GiB floor). It covers the widest set of backends (Ollama,
   LM Studio via the Responses API, vLLM, SGLang, MLX, llmman, LiteLLM) and supports a hosted primary
   with a local fallback. It carries an explicit warning that local models lack hosted safety filters.
   https://docs.openclaw.ai/gateway/local-models
3. **Perplexity Portable Computer and Hybrid compute.** Technically the most advanced: harness and
   model are co-designed and post-trained, skills load on demand, connectors are CLI tools, the
   sandbox fails closed, and escalation to a gated advisor is user-approved. But it is closed and
   one-click only. Models: Qwen 3.8 27B, PPLX 27B, and Nemotron 3.5 Lightning (soon) on DGX Spark or
   RTX PCs with 24 GB+ VRAM; Gemma 4 E4B, Qwen3.6 35B-A3B or a PPLX model on Macs with 24 GB+ unified
   memory. Users cannot bring their own local model.
   https://www.perplexity.ai/hub/blog/introducing-portable-computer-for-local-first-ai
   https://www.perplexity.ai/hub/blog/introducing-hybrid-compute-on-mac

**Good, documented, bring-your-own.**
- **OpenHands** gives the most prescriptive recipe: Qwen3.6-35B-A3B first; LM Studio, Ollama, vLLM or
  SGLang; the `openai/` prefix; context of at least 22K (32K advised); a 24 GB GPU or 64 GB Mac.
  https://docs.openhands.dev/openhands/usage/llms/local-llms
- **Cline** offers a compact prompt for local models (~10% of the full prompt, losing MCP), Qwen3 Coder
  30B A3B at 4-bit, and a desktop app built for open-weight models. https://cline.bot/blog/local-models
  and https://docs.cline.bot/usage/cline-desktop.md
- **Aider** avoids Ollama's silent 2K truncation by sizing `num_ctx` automatically.
  https://aider.chat/docs/llms/ollama.html
- **Kilo Code** supports Ollama, LM Studio and Atomic Chat, and warns local models lack caching and
  computer use. https://kilo.ai/docs/advanced-usage/local-models
- **Odysseus** has a hardware-aware "Cookbook" for downloading and serving models.
  https://github.com/odysseus-dev/odysseus
- **DeepSeek Harness** accepts any OpenAI- or Anthropic-compatible base URL, with no local guidance.
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md

**Weak or absent.**
- **Warp** accepts only public HTTPS endpoints; localhost is rejected, so Ollama needs an ngrok tunnel.
  https://docs.warp.dev/agents/inference/custom-inference-endpoint/
- **Amp**'s custom URL endpoint is in early access for top tiers only.
  https://ampcode.com/docs/markdown/customize/model-routing
- **Cursor** routes all requests through its own servers. https://cursor.com/docs/settings/api-keys
- **Gemini CLI** uses a local Gemma 1B for routing only; Google's local path is the Antigravity SDK.
  https://geminicli.com/docs/core/gemma-setup/ and
  https://developers.googleblog.com/introducing-support-for-local-ai-models-in-the-antigravity-sdk/
- **Devin** and **Manus**: not found.

**Patterns the field agrees on.**
- The hardware floor is about 24 GB of VRAM or unified memory for a useful agent model (OpenHands,
  Perplexity, Antigravity SDK).
- The Qwen 3.6 / 3.8 family (27B dense or 35B-A3B MoE) is the most recommended; Gemma 4 is next.
- Context must be forced up from runtime defaults: Ollama defaults to 2K (Aider) and Goose sees 4K–8K.
- Tool-call reliability is the binding constraint (Goose, Kilo, OpenHands).
- Harnesses built for frontier models must shrink their prompt and tool surface for local models:
  Cline's compact prompt, Perplexity's minimal core with on-demand skills and CLI connectors.

---

## 6. For Trent

Would a small-business, social-media or creator user notice this feature, or only a developer?

1. **Multi-model orchestration with a switchable orchestrator.** Both. Users feel it as cost and
   quality ("Light vs Ultra"); developers see the routing. Trent's model gateway can expose one effort
   dial rather than model names.
2. **Gated advisor escalation with a PII preview.** Users notice it strongly: "your client files stay
   on your machine; here is exactly what would be sent" is a trust feature a small business
   understands.
3. **Connectors as compact CLI tools plus on-demand skills.** Developer only, but it decides whether a
   local model works at all. It is the most transferable technique for Trent's local-model plan.
4. **Brain, the source-linked self-refreshing memory.** Users notice when the agent "already knows"
   their brand voice, clients and last campaign, and the "why do you know this" link builds trust.
5. **Email as an agent surface.** Users notice it immediately; forwarding a thread to an agent is
   zero-install for non-technical owners.
6. **Rewind (conversation, code, or both).** Developer; a creator would only notice it as "undo that".
7. **One control center for any ACP agent.** Developer; relevant if Trent wants to host Claude Code or
   Codex as a backend rather than compete with them.
8. **Custom branded distributions.** Neither directly. It matters to Trent's own business, as a
   precedent for white-labelled agent builds for agencies.
9. **Adversary reviewer agent.** Mostly developer. Users notice only if it blocks a bad post or send,
   which is exactly the moment it matters for social accounts.
10. **Import a Claude Code / Codex session and continue on an open-weight model.** Developer; a cheap,
    concrete migration path Trent could copy for local models.
11. **Long-lived coordinator with event subscriptions.** Both. Users notice "it watches my DMs /
    inbox / calendar and acts"; developers notice the PR and CI hooks.
12. **Video proof of work.** Users notice it strongly. A 30-second clip of "your landing page now
    works" beats a diff for a non-developer.
13. **Branch: fork with full context.** Users notice it: one research session turns into a post, a
    newsletter and a deck without re-explaining.
14. **Sleeping remote machines per thread.** Developer, and users only through the bill ("costs
    nothing while idle"). Relevant to long-running creator jobs such as video renders.
15. **The assistant inside WhatsApp, iMessage and Telegram.** Users notice it most of all: small
    businesses and creators already live in these channels. It is the strongest non-developer
    distribution pattern in the field.

Two warnings from the evidence that bear on Trent directly:
- Perplexity's benchmarks show a general-purpose harness (Hermes, Pi) losing 5–30 points to a
  harness shaped for a 27B local model on the same hardware [P14]. Adding local models to Trent by
  swapping only the base URL is likely to disappoint.
- Warp and Cursor show that when requests are routed through the vendor's servers, localhost models
  are blocked [W2][CU4]. A terminal-first Trent that calls the local runtime directly avoids this.

---

## 7. Source register (every URL read 2026-09-26 UTC)

**Perplexity**
- [P1] https://www.perplexity.ai/hub/blog/introducing-perplexity-computer (post dated 2026-02-25)
- [P2] https://www.perplexity.ai/products/computer
- [P3] https://www.perplexity.ai/hub/blog/everything-is-computer (2026-03-11)
- [P4] https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026 (2026-03-12)
- [P5] https://www.perplexity.ai/hub/blog/personal-computer-is-here (2026-04-16)
- [P6] https://www.perplexity.ai/hub/blog/personal-computer-is-available-to-all-mac-users (2026-05-07)
- [P7] https://www.perplexity.ai/changelog/computer-in-microsoft-365-improved-context-visibility-and-new-analytics (2026-05-28)
- [P8] https://www.perplexity.ai/changelog/deep-research-command-panel-forking-inline-actions-and-enterprise-controls (2026-06-18)
- [P9] https://www.perplexity.ai/changelog/brain-faster-computer-models-website-publishing (2026-07-13)
- [P10] https://www.perplexity.ai/changelog/role-based-access-controls-api-credentials-and-brain-for-max (2026-07-27)
- [P11] https://www.perplexity.ai/changelog/shared-workspaces-personal-computer-for-windows-and-model-council (2026-08-04)
- [P12] https://www.perplexity.ai/changelog/computer-in-email-gpt-5-6-terra-luna-and-grok-4-6 (2026-08-24)
- [P13] https://www.perplexity.ai/hub/blog/introducing-portable-computer-for-local-first-ai (2026-08-25)
- [P14] https://www.perplexity.ai/hub/blog/a-local-first-agent-for-private-and-cost-effective-knowledge-work (2026-08-25)
- [P15] https://www.perplexity.ai/hub/blog/introducing-hybrid-compute-on-mac (2026-09-01)
- [P16] https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace (2026-09-21)
- [P17] https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity
- [P18] https://www.perplexity.ai/pro
- [P19] https://www.perplexity.ai/max
- [P20] https://docs.perplexity.ai/docs/agent-api/skills
- [P21] https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity
- [P22] https://www.perplexity.ai/hub/academy/how-to-use-computer-skills

**Gemini CLI**
- [G1] https://github.com/google-gemini/gemini-cli (stars via API: 107,167)
- [G2] https://github.com/google-gemini/gemini-cli/releases
- [G3] https://geminicli.com/docs/
- [G4] https://geminicli.com/docs/cli/sandbox/
- [G5] https://geminicli.com/docs/core/subagents/
- [G6] https://geminicli.com/docs/hooks/
- [G7] https://geminicli.com/docs/cli/tutorials/session-management/
- [G8] https://geminicli.com/docs/core/gemma-setup/
- [G9] https://geminicli.com/docs/cli/model-routing/
- [G10] https://github.com/google-gemini/gemini-cli/discussions/24166
- [G11] https://developers.googleblog.com/introducing-support-for-local-ai-models-in-the-antigravity-sdk/ (2026-09-23)

**OpenHands**
- [O1] https://github.com/OpenHands/OpenHands (stars via API: 89,170)
- [O2] https://github.com/OpenHands/software-agent-sdk
- [O3] https://docs.openhands.dev/openhands/usage/llms/local-llms
- [O4] https://docs.openhands.dev/sdk/arch/condenser
- [O5] https://docs.openhands.dev/sdk/guides/task-tool-set
- [O6] https://docs.openhands.dev/sdk/guides/security
- [O7] https://docs.openhands.dev/sdk/guides/observability
- [O8] https://docs.openhands.dev/sdk/guides/metrics
- [O9] https://docs.openhands.dev/sdk/guides/plugins
- [O10] https://docs.openhands.dev/sdk/guides/persistent-memory
- [O11] https://docs.openhands.dev/sdk/guides/agent-stuck-detector
- [O12] https://docs.openhands.dev/sdk/guides/agent-acp

**Goose**
- [GS1] https://github.com/aaif-goose/goose (stars via API: 54,657; release v1.52.0 on 2026-09-23)
- [GS2] https://goose-docs.ai/docs/getting-started/providers
- [GS3] https://goose-docs.ai/blog/2026/04/24/use-goose-with-built-in-local-inference/
- [GS4] https://goose-docs.ai/docs/guides/recipes/
- [GS5] https://goose-docs.ai/docs/guides/context-engineering/
- [GS6] https://goose-docs.ai/docs/guides/security/
- [GS7] https://goose-docs.ai/docs/guides/managing-tools/goose-permissions
- [GS8] https://goose-docs.ai/docs/guides/sessions/smart-context-management

**Cline, Roo Code, Kilo Code**
- [C1] https://github.com/cline/cline (stars via API: 69,327)
- [C2] https://docs.cline.bot/running-models-locally/overview
- [C3] https://cline.bot/blog/local-models (post dated 2025-08-28)
- [C4] https://docs.cline.bot/usage/cline-desktop.md
- [C5] https://docs.cline.bot/llms.txt (feature index: Kanban, subagents, hooks, rules, checkpoints, OTel)
- [C6] https://docs.cline.bot/ (ClinePass $9.99/month)
- [R1] https://docs.roocode.com/sunset (redirects to https://roocodeinc.github.io/Roo-Code/)
- [R2] https://github.com/RooCodeInc/Roo-Code (API: archived true; 24,298 stars)
- [K1] https://github.com/Kilo-Org/kilocode (stars via API: 27,420)
- [K2] https://kilo.ai/docs/advanced-usage/local-models

**Cursor**
- [CU1] https://cursor.com/changelog
- [CU2] https://cursor.com/docs/agent/projects.md
- [CU3] https://cursor.com/docs/cloud-agent.md
- [CU4] https://cursor.com/docs/settings/api-keys
- [CU5] https://cursor.com/docs/agent/tools/terminal.md
- [CU6] https://cursor.com/llms.txt
- [CU7] https://cursor.com/docs/cloud-agent/self-hosted.md

**Devin**
- [D1] https://docs.devin.ai/llms.txt
- [D2] https://docs.devin.ai/cli/models.md
- [D3] https://docs.devin.ai/admin/billing/self-serve.md
- [D4] https://docs.devin.ai/cli/sandbox.md
- [D5] https://docs.devin.ai/onboard-devin/agents-md.md
- [D6] https://docs.devin.ai/work-with-devin/dynamic-workflows.md
- [D8] https://docs.devin.ai/work-with-devin/testing-and-recordings.md (read via the D1 index description)

**Manus**
- [M1] https://manus.im/blog/manus-resumes-independent-operations (2026-09-01)
- [M2] https://manus.im/blog/a-note-to-our-users (2026-08-11)
- [M3] https://manus.im/docs/llms.txt
- [M4] https://manus.im/docs/introduction/plans.md
- [M5] https://manus.im/docs/features/desktop.md
- [M6] https://manus.im/blog/manus-branch (2026-07-09)
- [M7] https://manus.im/docs/features/wide-research.md
- [M8] https://manus.im/docs/introduction/welcome

**Amp**
- [A1] https://ampcode.com/llms.txt
- [A2] https://ampcode.com/docs/markdown/customize/model-routing (lastModified 2026-09-25)
- [A3] https://ampcode.com/docs/markdown/the-dial
- [A4] https://ampcode.com/docs/markdown/pricing
- [A5] https://ampcode.com/docs/markdown/orbs
- [A6] https://ampcode.com/docs/markdown/puck

**Warp**
- [W1] https://github.com/warpdotdev/warp (stars via API: 65,161)
- [W2] https://docs.warp.dev/agents/inference/custom-inference-endpoint/ (updated 2026-09-24)
- [W3] https://docs.warp.dev/guides/external-tools/how-to-set-up-ollama/
- [W4] https://docs.warp.dev/agent-platform/getting-started/faqs/

**Aider**
- [AI1] https://github.com/Aider-AI/aider (stars via API: 49,186; last commit 2026-05-22 via the commits API)
- [AI2] https://pypi.org/project/aider-chat/ (0.86.2, uploaded 2026-02-12)
- [AI3] https://aider.chat/docs/llms/ollama.html
- [AI4] https://aider.chat/docs/llms/lm-studio.html
- [AI5] https://aider.chat/

**2026 launches and reference points**
- [N1] https://github.com/deepseek-ai/deepseek-harness (created 2026-08-13; stars via API: 236,019)
- [N2] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md
- [N3] https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- [N4] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md
- [N5] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md
- [N6] https://github.com/openclaw/openclaw (created 2025-11-24; stars via API: 390,522)
- [N7] https://docs.openclaw.ai/gateway/local-models
- [N8] https://github.com/odysseus-dev/odysseus (created 2026-05-31; stars via API: 87,601)
- [N9] https://api.github.com/search/repositories?q=created:>2026-01-01+stars:>8000&sort=stars&order=desc
- [N10] https://github.com/odysseus-dev/odysseus/blob/dev/website/setup.md
- [N11] https://github.com/NousResearch/hermes-agent (stars via API: 248,979)
- [N12] https://github.com/anomalyco/opencode (stars via API: 210,073)
- [N13] https://github.com/earendil-works/pi (stars via API: 109,367)
