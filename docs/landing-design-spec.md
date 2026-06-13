# Hubtown-style cinematic landing page — design

**Date:** 2026-06-12
**Request:** Restyle the Trent landing page (`app/page.tsx`) with the scroll animations,
smooth flow, and cinematic HUD aesthetic of hubtown.co.in — keeping Trent's brand
palette, fonts, and all existing copy. All code is original; no Hubtown assets,
text, or code are reproduced.

## Reference analysis (hubtown.co.in)

- Nuxt + single full-viewport WebGL canvas; body height = viewport (fully scroll-jacked).
  One wheel gesture = one ~1.5s eased chapter transition between full-screen scenes.
- HUD chrome: thin translucent frame around the viewport; top bar (logo left, boxy
  LOGIN/MENU right); bottom status bar with 3 cells (SOUND / EXPLORE / CHAT WITH US).
- Left rail chapter nav: square bullet + uppercase letter-spaced labels; active item
  bright, inactive dimmed; tracks current chapter.
- Type: Grotesk (display) + Commit Mono (HUD micro-labels). Centered ALL-CAPS tracked
  headings, short centered paragraph, beveled-corner CTA (SVG clip-path notch, thin
  border, tiny glyph, uppercase bold ~11px, tracking ~.16em).
- Scenes: cinematic dark blue, glowing centerpiece (cube over water), particle glints,
  text blur/fade-up on chapter arrival.

## Adaptation for Trent (palette/content unchanged)

Trent's landing is a content-rich marketing page (pricing, tables, calculator), so full
scroll-jacking would hurt usability. We keep native scroll but add a **Lenis-style
lerped smooth scroll** so the page glides like Hubtown, plus scroll-linked cinematics.

Color mapping: Hubtown electric blue → `--pulse` mint (#6EE7B7) on `--obsidian`
(#0A0A0F); secondary accent stays `--ember`. Fonts stay Inter / Instrument Serif /
JetBrains Mono (mono plays Commit Mono's HUD role).

## Components (all new, original code)

1. `components/landing/smooth-scroll.tsx` — fixed wrapper translated by an eased
   (lerp ~0.085/frame) copy of `window.scrollY`; body spacer preserves the native
   scrollbar, keyboard, and anchor jumps. Context exposes the eased value.
   ResizeObserver keeps spacer height in sync. Disabled for `prefers-reduced-motion`
   and coarse pointers (native scroll there).
2. `components/landing/fx.tsx` —
   - `BlurReveal`: heading/intro reveal — opacity 0→1, translateY ~36px→0,
     blur 14px→0, optional per-child stagger (the Hubtown text arrival).
   - `HeroExit`: scroll-linked hero departure — scale 1→0.94, fade out, blur in
     over the first ~90vh of scroll; cube layer parallaxes slower.
   - `useEasedScroll`: read the smooth-scroll value for scroll-linked effects.
3. `components/landing/scene.tsx` — fixed full-viewport canvas: perspective particle
   "sea" drifting toward the camera with sine bob, horizon glow, occasional ember
   glints; plus a CSS-3D glowing mint cube (slow Y-rotation, bob, layered glow) for
   the hero. DPR-capped, pauses when hidden, static under reduced motion.
4. `components/landing/hud.tsx` —
   - `HudFrame`: thin rgba(255,255,255,.08) frame inset around the viewport.
   - `ChapterRail`: left scroll-spy rail (square bullet + mono caps labels), six
     chapters; click glides to the section. Hidden under 1100px.
   - `HudBottomBar`: 3 cells — "OPERATING NOW · 9 AGENTS" (pulse dot) / "SCROLL"
     with animated chevron / "HIRE TRENT →".
5. `app/styles/landing-hub.css` — `.bevel` notched-corner box (nested clip-path
   polygons: outer = border, inner = fill), HUD classes, square-bullet eyebrow
   variant, keyframes (cube spin/bob, chevron drop, rail pulse).
6. `app/page.tsx` — same sections, same copy, new chrome:
   - Hero: full-viewport centered composition — cube centerpiece, mono caps eyebrow,
     giant lowercase `trent.` wordmark (brand), serif italic line, beveled CTAs;
     scroll-linked exit cinematic.
   - Section H2s: Hubtown treatment — uppercase, tracked, BlurReveal.
   - Buttons → beveled boxes; eyebrows → square-bullet HUD style.
   - Chapter anchors for the rail: intro / the hire / tasks / agents / outputs / pricing.

## Chapters (rail mapping)

00 INTRO (hero) · 01 THE HIRE (#hire) · 02 TASKS (#tasks) · 03 AGENTS (#agents) ·
04 OUTPUTS (#outputs) · 05 PRICING (#pricing)

## Accessibility & performance

- Native scroll preserved (the lerp only eases the painted position).
- `prefers-reduced-motion`: smooth scroll off, canvas static, reveals instant.
- Canvas: ≤260 particles, DPR ≤1.5, rAF paused off-tab.
- Left rail and cube hidden on small screens; bottom bar collapses.

## Out of scope

- Full WebGL scene replication, audio toggle, scroll-jacked chapter snapping,
  responsive rebuild of existing inline-styled grids.

## Rollback

Original page preserved at `docs/backups/2026-06-12-landing-page-v1.tsx.txt`
(repo is not a git checkout).
