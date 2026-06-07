# Trent — Claude Design Prompt
> Paste this at the top of any prompt where you want Claude to design or build UI for Trent.

---

You are designing UI for **Trent**, an AI cofounder operating system for solo founders. Every surface you create must feel like a premium instrument — the quiet authority of a Bloomberg terminal crossed with the restraint of a Braun product catalogue. Think a competing product.com: crisp, dark, animated with purpose, nothing decorative for its own sake.

---

## Personality in one sentence
Calm. Capable. Allergic to hype. Operator-grade. A console you'd actually trust with your company.

---

## Color system

Use these exact values. Never introduce colors outside this palette.

```
--obsidian: #0A0A0F   ← primary background, 90% of every surface
--ink:      #11111A   ← elevated surface (cards, sidebars)
--steel:    #1B1B26   ← higher surface (inputs, hover states)
--slate:    #262633   ← borders, subtle dividers
--haze:     #4A4A57   ← disabled text, meta labels
--mist:     #94A3B8   ← secondary text, placeholders
--bone:     #F1ECE2   ← primary text on dark, inverse background
--bone-2:   #E6E0D3   ← softer body text
--pulse:    #6EE7B7   ← AI activity signal (mint) — agents, cycles, success
--pulse-deep:#10B981  ← pulse pressed/hover state
--ember:    #FB923C   ← human moment signal (copper) — approvals, warnings, your turn
--ember-deep:#EA580C  ← ember pressed/hover state
--danger:   #F87171   ← critical errors only
```

**Sacred color grammar — never break this:**
- `--pulse` (mint) = Trent acted autonomously. Something happened.
- `--ember` (copper) = A human decision is required. Something is waiting.
- Never use both colors on the same element. Never swap them. Never use pulse for warnings or ember for success.
- ~90% of any surface is neutrals. ~8% is one signal color. ~2% is danger.
- No gradients on type. Gradients live only in atmospheric glows and hero backgrounds.

---

## Typography

Three families. Strict roles. Do not substitute.

| Family | Weight | Role |
|--------|--------|------|
| **Inter** | 300–900 | Everything: UI, headings, body, buttons, labels |
| **Instrument Serif** *(italic only)* | 400 | Editorial moments only — manifestos, taglines, the rare promise. Use sparingly. |
| **JetBrains Mono** | 400/500 | Data, status, agent IDs, cycle times, cost figures, code, timestamps, all caps labels |

**Type scale:**
- Display / H1: `clamp(48px, 8vw, 120px)`, weight 800, tracking `−0.04em`, line-height `0.92`
- H2: `clamp(36px, 5vw, 72px)`, weight 700, tracking `−0.035em`, line-height `1`
- H3: `clamp(22px, 2.4vw, 32px)`, weight 600, tracking `−0.02em`
- Lead / Serif: `clamp(22px, 2.6vw, 34px)`, Instrument Serif italic, line-height `1.35`
- Body: `16px`, line-height `1.65`, color `#CFCAC0`
- Mono label: `11px`, tracking `0.14–0.20em`, uppercase, color `--mist` or `--haze`

**Rules:**
- Sentence case everywhere: buttons, nav, headings. Title case reads corporate.
- Numbers as numerals always: "9 agents" not "nine agents", "3 PRs".
- The brand name is lowercase `trent` in product UI and Trent's own voice. Capitalized `Trent` in editorial/headlines.
- Oxford comma. Short sentences. Active voice.

---

## Spacing & layout

- Base grid unit: `8px`
- Max content width: `1280px`, centered, `padding: 0 32px` (mobile: `0 20px`)
- Section padding: `120px 0` (mobile: `80px 0`)
- Section dividers: `1px solid rgba(255,255,255,0.06)`
- Border radius scale: sm `6px`, md `14px`, lg `22px`, xl `32px`
- Card padding: `28px`

---

## Component patterns

### Cards
```
background: --ink
border: 1px solid rgba(255,255,255,0.07)
border-radius: 22px
padding: 28px
transition: transform 0.35s ease, border-color 0.35s
hover: translateY(-4px), border-color rgba(110,231,183,0.4)
```
- Pulse-themed card: icon background `rgba(110,231,183,0.08)`, icon color `--pulse`, icon border `rgba(110,231,183,0.2)`
- Ember-themed card: icon background `rgba(251,146,60,0.08)`, icon color `--ember`, icon border `rgba(251,146,60,0.2)`

### Buttons
- **Primary**: `background --bone`, `color --obsidian`, `font-weight 600`, `height 40px`, `border-radius 8px`, `padding 0 20px`
  - Hover: `background #E6E0D3`
- **Secondary**: `border 1px solid rgba(255,255,255,0.12)`, transparent bg, color `--bone`, same sizing
  - Hover: `background rgba(255,255,255,0.04)`
- **Pulse CTA**: `background --pulse`, `color --obsidian`, bold, for primary AI-trigger actions
- **Ember action**: `background --ember`, `color #1A0A05`, for approval/human actions
- No shadows. No gradients on buttons. Font: Inter.

### Inputs / forms
```
background: --steel
border: 1px solid rgba(255,255,255,0.08)
border-radius: 8px
color: --bone
placeholder: --haze
padding: 10px 14px
font-size: 14px
focus: border-color rgba(110,231,183,0.5), outline none, box-shadow 0 0 0 3px rgba(110,231,183,0.1)
```

### Eyebrow labels (section headers)
```
font-family: JetBrains Mono
font-size: 11px
letter-spacing: 0.18em
text-transform: uppercase
color: --mist
display: flex
align-items: center
gap: 10px
margin-bottom: 24px
```
Prepend a mint dot: `width 6px, height 6px, border-radius 50%, background --pulse, box-shadow 0 0 0 4px rgba(110,231,183,0.15)`

### Status pills / badges
```
font-family: JetBrains Mono
font-size: 10–11px
letter-spacing: 0.14em
uppercase
border: 1px solid rgba(255,255,255,0.08)
border-radius: 999px
padding: 4px 10px
```
- AI/pulse badge: `color --pulse`, `background rgba(110,231,183,0.08)`
- Ember/approval badge: `color --ember`, `background rgba(251,146,60,0.08)`
- Neutral: `color --haze`, `background --steel`

### Navigation (fixed top bar)
```
position: fixed
background: linear-gradient(180deg, rgba(10,10,15,0.92), rgba(10,10,15,0.5) 80%, transparent)
backdrop-filter: blur(14px)
padding: 18px 32px
border-bottom: none (gradient fades)
```
Nav links: JetBrains Mono, 11px, tracking `0.14em`, uppercase, color `--mist`. Hover: `border 1px solid rgba(255,255,255,0.08)`, `border-radius 999px`, `background rgba(255,255,255,0.03)`

### Sidebar (app shell)
```
background: rgba(0,0,0,0.18)
border-right: 1px solid rgba(255,255,255,0.05)
width: 220px
padding: 24px 18px
```
Group labels: JetBrains Mono, 9px, tracking `0.20em`, uppercase, `--haze`
Active nav item: `background rgba(110,231,183,0.06)`, `color --bone`, `box-shadow inset 0 0 0 1px rgba(110,231,183,0.18)`, `border-radius 8px`

### Console / app mockup chrome
```
border: 1px solid rgba(255,255,255,0.08)
border-radius: 32px
background: --ink
box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 30px 80px -30px rgba(0,0,0,0.6)
```
Window chrome bar: `padding 14px 18px`, traffic lights as `10px` circles in `--slate`, URL bar in `--steel`.

### Agent row (activity log item)
```
display: grid
grid-template-columns: 30px 1fr auto auto
gap: 14px
padding: 12px 14px
border: 1px solid rgba(255,255,255,0.05)
border-radius: 10px
background: rgba(255,255,255,0.01)
font-size: 13px
```
Agent icon chip: `30px`, `border-radius 8px`, JetBrains Mono, 11px, weight 600, `background rgba(110,231,183,0.08)`, `color --pulse`

### Approval card (the human moment)
```
border: 1px solid rgba(251,146,60,0.25)
background: rgba(251,146,60,0.04)
border-radius: 12px
padding: 16px
```
Title: `color --ember`, weight 600, 13px, with `◆` prefix.
Actions: Approve button `background --pulse, color --obsidian`. Reject: transparent with `--slate` border.

---

## Iconography

Single stroke language: `1.6px` stroke width, rounded caps and joins, `24px` grid. Lucide icons are the default library — they match this spec exactly. Icons are always `color: currentColor`. Apply a signal color only when communicating a state change, never decoratively.

---

## Animation principles

Every animation must feel deliberate and earned. No bounce. No spring (unless very subtle). Prefer:

- **Opacity + translateY**: elements enter at `opacity: 0, transform: translateY(20px)` → `opacity: 1, translateY(0)`, easing `cubic-bezier(0.16, 1, 0.3, 1)`, duration `0.6–0.8s`
- **Stagger**: when multiple items animate in together, delay each by `80–120ms`
- **Scroll-triggered**: use `IntersectionObserver` with `threshold: 0.1`. Once fired, do not replay.
- **Hover micro-interactions**: `transition: transform 0.35s ease, border-color 0.35s, background 0.35s`. Cards lift `translateY(-4px)`. Buttons scale subtly (`scale(0.98)` on press).
- **The pulse dot**: `box-shadow` keyframe animation at 2.4s infinite — `0 0 0 0 rgba(110,231,183,0.4)` → `0 0 0 12px rgba(110,231,183,0)`. Use only on active/live status indicators.
- **Scroll progress bar**: fixed top, `height 2px`, `background: linear-gradient(90deg, --pulse, --ember)`.
- **Counter animations**: stats count up from 0 on scroll-enter using `requestAnimationFrame`. Duration 1.2s, easing ease-out.
- **No rotation transitions. No elastic bounce. No dramatic scale transforms.** Trent is calm.

For landing pages and marketing surfaces, add:
- A `radial-gradient` atmospheric glow in the hero (mint at ~18% opacity + ember at ~12% opacity), with `filter: blur(40px)`, pointer-events none
- A grid overlay: `linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px)` at `64px × 64px` tile, masked with a radial gradient so it fades at edges
- Grain/noise texture overlay: an `<svg>` filter or canvas-based subtle noise at `3–5% opacity` on the body for depth

---

## Voice in UI copy

| Situation | Write this | Not this |
|-----------|-----------|---------|
| Agent completed | "Shipped onboarding refactor. 3 PRs merged." | "🚀 Big day! We made awesome improvements!" |
| Needs approval | "PR #88 awaiting your approval. Tests passing." | "Heads up! Something needs your attention 👋" |
| Error | "Cycle failed. OpenAI timeout after 30s. Retry?" | "Oops! Something went wrong. Please try again." |
| Empty state | "No cycles yet. Run your first cycle to begin." | "Wow, it's quiet here! Get started today!" |
| Budget cap | "Budget cap reached. Resume or roll fresh Monday?" | "You've reached your limit for this week!" |

Rules: State the state. Hand back control. No emoji. No exclamation marks unless a human just shipped something real. Mono font for all status/data strings.

---

## Surface hierarchy (z-order mental model)

```
Layer 0 — Page:        --obsidian  #0A0A0F
Layer 1 — Card/Panel:  --ink       #11111A
Layer 2 — Input/Hover: --steel     #1B1B26
Layer 3 — Active/Pill: --slate     #262633
Accent ──────────────: --pulse or --ember (never both simultaneously)
Text/Overlay:          --bone at full, --bone-2 for body, --mist for meta, --haze for disabled
```

---

## Page-by-page design intent

### Landing page (marketing)
a competing product-level crispness. Full-screen hero with the wordmark `trent·` at display scale, the mint dot pulsing live. Atmospheric radial glow behind it. Grid overlay fading to edges. Below the fold: a manifesto quote in Instrument Serif italic, then feature cards (3-col grid), then an animated console mockup showing the 9 agents working, then a stats row with counters (9 agents, 24/7, 1 decision/day), then a CTA section with a mint glow. All sections animate in on scroll with staggered opacity+translateY. Ticker/marquee of operating concepts in JetBrains Mono between sections.

### Sign-in page
Centered, austere. The mark (console icon) + wordmark. Single email input. Bone-colored primary button. Tagline below: *"For local development, enter any email to sign in."* No card border radius above `14px`. Atmospheric mint glow faint in the top-right corner.

### Companies list (`/companies`)
A portfolio view. Header: "Your companies." Each company is a card (22px radius, hover lift) with: company name in Inter semibold, a mono status chip (● operating / ○ paused), the cycle count, budget used this week, last cycle time. Empty state: centered, mono text, a `+` button. "New company" opens a slide-over or inline form.

### Company dashboard (`/companies/[id]`)
Three-panel console layout:
- Left sidebar (220px): portfolio switcher, workspace nav (Console, Queue, Approvals, Reports, Memory), operate nav (Cycles, Budgets, Audit, Integrations)
- Main area: "One decision today" card in ember, then the live agent activity log (agent rows), then cycle timeline
- Right panel (280px): today's cycle summary, the approval card if pending, budget meter

### Approvals queue
Ember-toned. Header chip `◆ 2 awaiting`. Each approval is a full-width card with: action title, agent source, reasoning, estimated impact, Approve/Reject buttons. Approved items collapse with a mint checkmark. Rejected items collapse with a muted strikethrough.

### Cycles view
Timeline layout. Each cycle is a row: cycle number (mono), timestamp, status chip (mint = complete, ember = running, muted = queued), expand to see agent-by-agent breakdown. Running cycle has a pulsing mint dot.

### Reports
Document-like. Left: report list (mono timestamps, titles). Right: rendered markdown prose in Inter, Instrument Serif for pull quotes. The "Sunday letter" is rendered differently — larger serif, more whitespace, bone-tinted background behind it.

### Memory / search
Full-width search bar at top (Inter, 18px, --steel background). Results in a list: source icon (agent chip), title, excerpt, timestamp. Highlight matches in --pulse.

### Integrations
Cards for each integration: GitHub (active/mint chip), Linear, Notion, Postmark, Stripe. Inactive integrations are desaturated with a "Not connected" ember pill. No toggle switches — buttons say "Connect" or "Disconnect".

### Settings / company brief
Clean form layout. Section headers in JetBrains Mono eyebrow style. Fields for vision, goals, market, metrics. Budget cap slider (styled with --pulse fill). Kill switch: a full-width ember-bordered `Pause all agents` button at the bottom, treated as a feature, not a footnote.

---

## Things to never do

- ❌ No drop shadows (depth is implied through color value, not effects)
- ❌ No gradients on type or buttons
- ❌ No rounded corners above `32px` (xl) for main surfaces
- ❌ No emoji in UI (product voice only — never decorative)
- ❌ No pulse and ember on the same element
- ❌ No title case in headings or buttons
- ❌ No modal dialogs for destructive actions — use inline confirmation or slide-overs
- ❌ No infinite loading spinners — use skeleton states in `--steel` with a shimmer
- ❌ No color outside the palette
- ❌ No fonts outside Inter, Instrument Serif, JetBrains Mono
- ❌ No animation that loops decoratively — only pulse dot and scroll progress bar are persistent
- ❌ No bounce or spring physics — Trent is calm

---

## Quick-start snippet (copy into any Claude prompt)

```
Design this using the Trent design system:
- Background: #0A0A0F (obsidian) with #11111A (ink) for cards
- Accent: #6EE7B7 (mint/pulse) for AI activity, #FB923C (ember) for human moments
- Text: #F1ECE2 (bone) primary, #94A3B8 (mist) secondary, JetBrains Mono for all data/status
- Fonts: Inter (UI), Instrument Serif italic (editorial only), JetBrains Mono (data)
- Cards: 1px border rgba(255,255,255,0.07), 22px radius, hover lift translateY(-4px)
- Animations: opacity+translateY on scroll, 0.6–0.8s, cubic-bezier(0.16,1,0.3,1), stagger 100ms
- Voice: sentence case, no emoji, state the state, short sentences
- Feel: Bloomberg terminal × Braun catalogue × a competing product.com crispness
```
