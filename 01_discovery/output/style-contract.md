# Cross-surface style contract (Stage 00) — AUTHORITATIVE

Sources: `apps/web/brand/DESIGN_PROMPT.md` (written brand contract),
`apps/web/brand/trent-brand-book.html`, and the CSS in `apps/web/app/styles/*`. All three agree.

## The sacred color grammar (from the brand book, quoted)
> `--pulse` (mint) = Trent acted autonomously. `--ember` (copper) = A human decision is required.
> Never use both on the same element. Never swap them. ~90% neutrals, ~8% one signal color, ~2% danger.

**State outranks identity.** An agent awaiting a human turns ember regardless of its category color.

## Hard rules that override the v1 spec documents
1. **No emoji in output, anywhere.** This kills the v1 format `paperclip file.ts / clock 2.3s / moneybag $0.12 / robot model`.
   Completion metadata is mono uppercase text in haze instead.
2. Sentence case in prose. UPPERCASE only for mono status labels, letter-spaced where width allows.
3. Body text is **mist #94A3B8**, not bone. Bone is reserved for emphasis and values.
4. Diff-add is **pulse**, diff-del is **ember** — not green/red.
5. Selection is a mint `▎` in column 0, never a full-row invert.
6. One easing only: `cubic-bezier(0.16, 1, 0.3, 1)`. No bounce, spring, or rotation.

## ANSI table
| token | hex | truecolor FG | 256 | 16-color | CLI role |
|---|---|---|---|---|---|
| obsidian | 0A0A0F | 48;2;10;10;15 | 232 | default bg | terminal bg (do not paint) |
| ink | 11111A | 48;2;17;17;26 | 233 | — | panel fill |
| steel | 1B1B26 | 48;2;27;27;38 | 234 | — | input line, selected row |
| slate | 262633 | 38;2;38;38;51 | 236 | bright black | box-drawing borders |
| haze | 4A4A57 | 38;2;74;74;87 | 240 | bright black | meta, timestamps |
| mist | 94A3B8 | 38;2;148;163;184 | 145 | white | **default body text** |
| bone | F1ECE2 | 38;2;241;236;226 | 255 | bright white | emphasis, values |
| bone-2 | E6E0D3 | 38;2;230;224;211 | 254 | bright white | code body |
| pulse | 6EE7B7 | 38;2;110;231;183 | 121 | bright green | prompt, success, diff-add, selection, caret |
| ember | FB923C | 38;2;251;146;60 | 215 | yellow | approval needed, warning, diff-del |
| danger | F87171 | 38;2;248;113;113 | 210 | bright red | failure, blocked |
| sky | 7DD3FC | 38;2;125;211;252 | 117 | bright cyan | info, awaiting approval, connected |

Detection order: `NO_COLOR` -> monochrome; `COLORTERM=truecolor|24bit` -> 24-bit; `TERM=*-256color`
-> 256; else 16. Monochrome carries meaning by glyph: `●` running, `◆` needs approval, `✓` done,
`✗` failed, `·` idle.

## Motifs to translate into terminal art
- **HUD frame**: dim slate border with mint L-brackets at top-left and bottom-right ONLY (`.hub-frame`).
  This is the single best motif for TUI/desktop chrome.
- **Fading rule**: section headers followed by a line that starts mint and decays to haze then blank
  (`.pagehead::after`).
- **Pulse dot**: 2.4s breathe, `●`/`○`. The most identifying element in the product.
- **Mint left rail**: `▎` marks the active row (`.nav-item[data-active]`).
- **Atmosphere grid**: 64px lattice -> a dim `·` field. Drop the grain; keep a mint top-left /
  ember bottom-right corner tint.
- **Beveled button**: 10px clipped bottom-right corner renders as a cut-corner box.

## Agent category colors (13 categories, proposed — no mapping exists in the app)
engineering #67E8F9 · product #6EE7B7 · design #F9A8D4 · marketing #FB923C · paid-media #FDBA74 ·
sales #FDE68A · finance #A5F3D2 · project-management #A5B4FC · testing #7DD3FC · support #C4B5FD ·
academic #E6E0D3 · spatial-computing #5EEAD4 · specialized #94A3B8
All derived from existing brand values (landing demo colors + tokens); all L~0.78-0.85 for dim
terminals. Agent prefix renders `● [Name]` where the dot carries STATE colour and the name carries
category colour.

## The mark
There are **zero image assets in the repo**. The logo is pure CSS/JSX (`components/ui/index.tsx:17`
`ConsoleMark`, `:63` `Wordmark`): lowercase Inter Black `trent` at -0.06em tracking followed by a
glowing mint dot — read it as `trent·`. Compact form is a mint dot before an Inter Black `T`.
Terminal: block-letter `TRENT` in bone with a trailing mint `●`. Prompt prefix: `●`.
**A 1024x1024 icon must be authored for Tauri** — none exists.

## Existing terminal styling in the app — match exactly
`workbench-sandbox-modal.tsx:384`: mono 12px, line-height 1.7, colour `--mist`, bg rgba(0,0,0,.18).
`agent-activity.css:203-230`: code block 11px mono, `--bone-2`, diff-add `--pulse`, diff-del `--ember`.
Do NOT port `app/styles/trust-panel.css` — it is a light-theme orphan referencing tokens that do not exist.
