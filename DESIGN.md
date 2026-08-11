---
name: Marol
description: "The Ultramarine Desk — a warm near-black ground, one committed jewel, and color spent only on what is happening"
colors:
  blooded-ink: "#161214"
  desk-shadow: "#1b1719"
  desk-surface: "#221c1f"
  machined-seam: "#322a2e"
  warm-bone: "#ebe6e3"
  quiet-ink: "#a69ba0"
  faintest-honest-ink: "#90858b"
  electric-ultramarine: "#6f7dff"
  quiet-sage: "#7dc48d"
  lantern-amber: "#e0af68"
  signal-rose: "#e26d72"
  on-accent-ink: "#0d1017"
typography:
  hero:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "20px"
    letterSpacing: "0.02em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "16px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "13px"
    lineHeight: 1.55
  data:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "12px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "11px"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: "10px"
    fontWeight: 700
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
rounded:
  xs: "5px"
  s: "6px"
  m: "8px"
  l: "10px"
spacing:
  gutter-x: "11px"
components:
  button:
    backgroundColor: "{colors.desk-surface}"
    textColor: "{colors.warm-bone}"
    rounded: "{rounded.s}"
    padding: "5px 10px"
  button-primary:
    backgroundColor: "{colors.electric-ultramarine}"
    textColor: "{colors.on-accent-ink}"
    rounded: "{rounded.s}"
    padding: "5px 10px"
  button-danger:
    backgroundColor: "{colors.desk-surface}"
    textColor: "{colors.signal-rose}"
    rounded: "{rounded.s}"
    padding: "5px 10px"
  chip:
    backgroundColor: "{colors.desk-surface}"
    textColor: "{colors.warm-bone}"
    typography: "{typography.data}"
    rounded: "{rounded.xs}"
    padding: "2px 8px"
  input:
    backgroundColor: "{colors.blooded-ink}"
    textColor: "{colors.warm-bone}"
    rounded: "{rounded.s}"
    padding: "6px 8px"
  board-card:
    backgroundColor: "{colors.desk-surface}"
    textColor: "{colors.warm-bone}"
    rounded: "{rounded.m}"
    padding: "9px 11px"
  modal:
    backgroundColor: "{colors.desk-shadow}"
    textColor: "{colors.warm-bone}"
    rounded: "{rounded.l}"
    padding: "18px 20px"
    width: "520px"
---

# Design System: Marol

## Overview

**Creative North Star: "The Ultramarine Desk"**

A warm near-black desk — ink with blood in it, not server-room gray — on which real terminals are laid out like instruments, and one committed jewel of an accent: electric ultramarine at full saturation, where a polite editor-theme blue would have disappeared into the category. The desk itself stays quiet so that the only loud things on it are the agents' own terminals and the moments a human is actually needed. Color is a language of events, not of decoration: a colored edge means something is *happening*; rest is neutral.

The system is dense, honest, and machined. Dense: 13px body type, 220px sidebar, 5–10px paddings — an operator's console, not a marketing page. Honest: nothing is shown that was not measured — quiet text is a token that still clears AA, never an opacity; a session with no status signal wears a disclaimer, never a guess. Machined: every surface lifts the same way, from the same one-pixel bevel of light, and consequence has a two-click grammar. Components are **quiet instruments; consequence is armed**.

Confirmed anti-references: server-room gray grounds; any editor theme's polite blue; chat-bubble re-rendering of terminal output; "a board of stripes" — resting color on every card edge, the way state language degrades into decoration.

**Key Characteristics:**
- Eleven theme tokens; every other color in the app is `color-mix()` over them
- Warm near-black three-tier ground with a fixed 2.5% top-light gradient
- One saturated accent used as focus voice, cursor, and event color — never as wallpaper
- State speaks through 3px card edges, 7px dot shapes, and two named motions
- CJK-aware type floor (12px for anything scanned) and whole-button wrapping
- WCAG AA 4.5:1 kept as a floor on every text tier, on the surface it actually sits on

## Colors

A warm-dark neutral ladder under one jewel accent and a load-bearing semantic trio; the palette is the default **ink** preset, which is also the literal `:root` of `ui/src/styles.css` and the seed of every derived theme.

### Primary
- **Electric Ultramarine** (#6f7dff): the one committed jewel. Focus rings (2px, offset -1px, on everything focusable), the terminal cursor, active tab underline, running-state edges and dots, drop targets, unread pills, links. It marks *attention and motion*, never territory.

### Neutral
- **Blooded Ink** (#161214): the ground. Page body (under a fixed `linear-gradient(180deg, color-mix(in srgb, var(--fg) 2.5%, var(--bg)), var(--bg) 42%)` — the desk catches light at the top), terminal backgrounds, input fields, receded cards.
- **Desk Shadow** (#1b1719): first raised tier — sidebar, topbar, pane heads, modals, board columns, overview cards, the inspector.
- **Desk Surface** (#221c1f): highest tier — buttons, chips, board cards, menus, kbd, active/selected fills.
- **Machined Seam** (#322a2e): every 1px hairline border and every resting status edge. The only border color.
- **Warm Bone** (#ebe6e3): primary ink.
- **Quiet Ink** (#a69ba0): secondary ink — labels, section heads, status lines.
- **Faintest Honest Ink** (#90858b): the quietest text that still clears 4.5:1 on every surface tier. De-emphasis is this token, never opacity.

### Semantic
- **Quiet Sage** (#7dc48d): ok — idle dots, diff additions, "what was kept" banners, the clear finish path.
- **Lantern Amber** (#e0af68): warn — every blocked-on-a-human state, the breath, armed mutation (merge), queued edges, behind-counts.
- **Signal Rose** (#e26d72): err — errors, diff deletions, armed deletion, close-hover, no-match states.
- **Violet-Crimson** (derived): `color-mix(in srgb, var(--accent) 55%, var(--err) 45%)` — the seventh meaning: *merged*, landed, the loop's peak. Deliberately derived, never pinned to a hex, so custom themes inherit it for free.
- **On-Accent Ink** (#0d1017): text on solid accent fills; recomputed per theme as near-black or white, whichever wins on WCAG contrast.

### Theming
The whole interface speaks exactly eleven tokens (`--bg, --bg-2, --bg-3, --line, --fg, --fg-dim, --fg-faint, --accent, --ok, --warn, --err`). Five hand-tuned presets exist (ink · paper (light) · pine · wisteria · sunset); a custom theme asks for only six primaries and derives the tiers by sRGB mixing: bg-2 = mix(bg,fg,2%), bg-3 = 5%, line = 11%, fg-dim = 63%, fg-faint = 54% — "the formula is the tuning, generalized." Light themes flip the terminal's entire ANSI ramp. The semantic trio keeps its hues across every preset: they are load-bearing.

### Named Rules
**The One Jewel Rule.** There is one saturated accent and it is spent on attention and motion. A resting surface never wears it; an idle card's edge is Machined Seam, not blue.
**The Eleven Tokens Rule.** No component may introduce a new color. New meanings derive, the way Violet-Crimson does; hovers, tints, and armed states are `color-mix()` percentages over the tokens (4–7% resting tints, 9–12% active tints, 18–35% selections and semantic borders, 45% animation peaks).
**The No-Container-Opacity Rule.** De-emphasis uses Faintest Honest Ink; opacity on a container drags the buttons and data inside it below AA with it. Cards recede by losing fill and edge, never by fading their text. The only sanctioned opacity: disabled controls at 0.4, and hover-revealed actions going 0→1.

## Typography

**UI Font:** system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC"`) — the TC entries are the zh-TW story; no remote fonts in a desktop app.
**Data/Mono Font:** IBM Plex Mono (self-hosted, OFL, latin-only; weights 400/500/600; CJK falls through to system). It is the product's voice for data — branches, paths, stats, kbd, diffs, and the terminals themselves (13px there, lineHeight exactly 1, or a TUI's box drawing comes apart).

**Character:** an instrument panel, not an editorial page. One sans for reading, one mono for anything the machine said. React does not mount until Plex Mono is loaded (raced against 500ms) — a terminal measured against a fallback would tear its own grid.

### Hierarchy
The ladder has seven named rungs; 87 hardcoded sizes were consolidated into them.
- **hero** (20px, letter-spacing 0.02em): the boot screen's one line.
- **heading** (16px): a dialog's one h2.
- **glyph** (15px, line-height 1): icon-button glyphs only.
- **body** (13px / 1.55): prose and titles — what is actually read. The app's base size.
- **data** (12px): status lines, code, chips, diffs — what the wall is scanned by. **The CJK floor**: dense zh-TW glyphs at 11px are read, not glanced.
- **label** (11px): labels and hints — read once, then recognized.
- **micro** (10px, weight 700): counts inside pills, nothing else.

Weights: 600 for titles, primary buttons, section heads, armed warnings; 700 only for tab badges and pill counts. Letter-spacing is reserved for small uppercase-feel heads (0.05–0.08em on sidebar/section/column heads). Line-heights: 1.55 body, 1.5 code/diff, 1.6 coach prose, 1 for glyphs.

### Named Rules
**The Scanned-vs-Read Rule.** Anything scanned repeatedly (status lines, the wall) sits at 12px or above; 11px is only for things read once and then recognized. Dense CJK decides this floor, not latin.
**The Whole-Word Rule.** Buttons wrap as whole buttons, never inside a word — a CJK label broken across lines (繼/續 stacked) reads as a different word. Card titles clamp at two lines because zh-TW titles say less per character-width.

## Layout

An operator's density: the app is a two-column grid — 220px sidebar (Desk Shadow, hairline right edge) beside the main column (topbar → tab strip → content row). The content row holds the terminal wall, board, or overview, with the inspector (460px, max 46vw) and preview/peek (`clamp(320px, 30vw, 520px)`) as flex-row *neighbors* that narrow the terminals rather than covering them.

- Board: 4 columns, `minmax(180px, 1fr)`, gap 12px (180px floor so 完成 is never clipped). Overview: `repeat(auto-fill, minmax(280px, 1fr))`, gap 10px.
- Terminal panes never go below **490×350px** — Claude Code's TUI box drawing comes apart below ~60 columns at 13px. Column count derives from width, never from session count. Pane gap 5px, splitter hit area 9px.
- Spacing is deliberately **not** tokenized beyond `--gutter-x: 11px` (the inspector family's shared left edge — meta, chips, banners, timeline, diff summary all breathe against it). Remaining paddings are per-surface optical tuning: 5–10px on controls and rows, 9–12px on cards, 18–20px on modals. Recurring gaps 6/7/8px.
- Hit targets never go below **18px square**, whatever the glyph size.
- The find bar is an overlay, not a header row: the terminal's size must not change under the TUI. Chrome padding lives on the pane, never inside the terminal.

## Elevation & Depth

**The Desk Rule.** Things lying on the desk are flat: they separate by the three-tier ground ladder (Blooded Ink → Desk Shadow → Desk Surface) and by the bevel, and they never cast a shadow. Only what *floats above the desk* carries one — and it earns a big, soft, literal-black shadow.

The bevel is material, not decoration: `--bevel: inset 0 1px 0 color-mix(in srgb, var(--fg) 7%, transparent)` — a one-pixel light catching the top of anything that sits on the desk (cards, panes, dialogs, toasts). Every surface lifts the same way, from the same token. Animated box-shadows must re-declare the bevel in every keyframe, or the breath would strip the card's machined edge on each cycle.

### Shadow Vocabulary
- **Modal** (`var(--bevel), 0 18px 50px rgba(0,0,0,0.5)`): dialogs, over a `rgba(0,0,0,0.55)` backdrop.
- **Palette** (`0 12px 40px rgba(0,0,0,0.5)`): the command palette.
- **Menu** (`var(--bevel), 0 10px 32px rgba(0,0,0,0.5)`): the world menu.
- **Toast / Coach** (`var(--bevel), 0 6px 24px rgba(0,0,0,0.45)`): bottom-center toasts, corner coach marks.
- **Find bar** (`0 2px 8px color-mix(in srgb, #000 25%, transparent)`): the smallest floater.
- **Accent rings** (`0 0 0 1px/2px …`): selection and drop emphasis, mixed from accent or warn — signals, not depth.

## Shapes

Gently rounded, tightly stepped: a four-rung radius ladder — **xs 5px** (chips, kbd, small controls), **s 6px** (buttons, inputs, panes, rows), **m 8px** (cards, toasts), **l 10px** (modals, palette, board columns, coach). Containers are always one rung softer than what they contain.

**The Pill Rule.** Pills are literal `999px` and stay out of the ladder — a pill is a shape, not a rung (unseen count pills, section counts, stale badges).

**Shape survives what color cannot.** The 7px status dots are a shape vocabulary, not a color ramp: filled = the state itself (running accent, waiting-permission amber, idle sage); hollow (1.5px inset ring) = its quieter cousin (starting, waiting-input); the trust gate is a rotated square — a door to answer once, not a light to watch. Opacity variants of one color were indistinguishable at 7px.

The **3px status edge** on cards is the product's state language (defended by lint pragmas in the stylesheet): border-left, Machined Seam at rest, colored only when something is happening. Neutral "off" states mix Warm Bone into the ground instead of inventing grays (stopped 26%, parked 14%).

## Components

Component philosophy: **quiet instruments; consequence is armed.** Controls are restrained at rest, reveal on aim (hover *or* focus), and rename themselves before doing anything irreversible.

### Buttons
- **Shape:** radius s (6px), padding 5px 10px, `font: inherit`.
- **Default:** Desk Surface fill, Machined Seam border; hover mixes 5% Warm Bone into the fill.
- **Primary:** solid Electric Ultramarine, On-Accent Ink text, weight 600; hover `filter: brightness(1.08)`.
- **Danger:** outline-tinted, never filled — Signal Rose text, 35% rose border. Red is for deletion.
- **Armed (signature):** destructive/mutating actions speak a two-click grammar — the first click arms and *renames the button to say what it will do*, the second fires, walking away auto-disarms (4s; 7s for merge/discard, because the armed label names a branch). Armed delete arms in Signal Rose; armed merge pauses in Lantern Amber — it is the loop's peak, but it mutates the base branch: warn for mutation, red for deletion.
- **Disabled:** opacity 0.4 on the control itself, never on a container.
- **Focus:** the one focus voice — `outline: 2px solid var(--accent); outline-offset: -1px` on everything focusable, including button-shaped custom elements.

### Board Card (signature)
- Desk Surface fill, Machined Seam hairline + bevel, radius m, padding 9px 11px, `cursor: grab`; title 600/13px, two-line clamp.
- **The 3px status edge** carries the second axis: rest = seam; **needs-you** = amber edge + 5% amber wash + THE BREATH; **astir** (mid-turn) = THE SHIMMER on an accent edge; queued = amber edge; stopped/parked/finished recede by fill and edge (never text opacity); **merged** keeps Violet-Crimson after the fact — discarded and superseded stay neutral, declining is not a state to advertise.
- The no-signal chip (agents with no hooks — everything but Claude Code and Codex) wears Faintest Honest Ink: a disclaimer, never a status.
- Motion pair: **THE BREATH** (breathe 2.4s ease-in-out infinite — a 0→2px amber-28% ring; anything blocked on a human breathes, and nothing else on the desk may pulse at attention scale) and **THE SHIMMER** (3.6s edge glow — weather, never a request). Breath outranks shimmer. Both settle to honest static states under `prefers-reduced-motion`. The only other motions in the app: the empty-board CTA's beckon (3.2s) and a 120ms background ease on session rows. Everything is `ease`/`ease-in-out`; no cubic-bezier exists.

### Session Row (sidebar)
Transparent, radius s, padding 5px 8px; active = Desk Surface; hover = 4% Warm Bone tint; the app's one transition (background 120ms) so re-sorting reads as a move, not a flicker. Status line at data size in Quiet Ink with the tool name in accent and elapsed pushed right in Faintest Honest Ink. Unread wears mail's grammar: weight on the name plus an accent dot — never mistakable for the busy dot. Row actions are opacity 0 until hover **or** focus-within.

### Tabs
12px Quiet Ink on the ground, 2px transparent underline; active = Warm Bone + accent underline + Desk Shadow fill. Badges: waiting = amber 700; unseen = filled accent pill (micro 700, On-Accent Ink); busy = accent text. Close button reveals on hover/focus, hovers to Signal Rose.

### Inputs
Fields sit on the deepest surface (Blooded Ink) while buttons sit on the highest — the well you type into. Machined Seam border, radius s, padding 6px 8px; error state turns border and text Signal Rose (find bar's no-match).

### Chips
Desk Surface, seam border, radius xs, padding 2px 8px, data size — a chip is a chip whatever element carries it; chips double as small action buttons (copy, run, dismiss).

### Modal
Desk Shadow, radius l, padding 18px 20px, 520px (wide 720px), bevel + the modal shadow over a 0.55 black backdrop. Escape always closes; a dirty dialog ignores backdrop clicks; focus is trapped and restored.

### Command Palette
Top-anchored (12vh padding — the list growing must not bounce the input), 560px, radius l; input borderless except a bottom hairline; selected item = Desk Surface fill; kbd chips in mono label size.

### Banners
One tint recipe, three meanings: fill = 6–7% of the semantic mixed into Desk Shadow, text in the semantic, hairline border. **Accent = a plan in motion, not a problem** (queued, preview-pick); **sage = what was kept** (restore); **amber = what stands in the way** (commit/rebase warnings).

### Diff (inspector)
12px mono, line-height 1.5; color lives on text, not row fills: additions Quiet Sage, deletions Signal Rose, hunks accent, meta Quiet Ink. Syntax tint mixes **from currentColor** so an added string stays green (`.tk-str: color-mix(in srgb, currentColor 72%, var(--fg))`). Sticky per-file headers; commentable lines hover accent-12%; noted lines accent-18% with a 2px accent left edge.

### The Door Pattern
Rows and cards are never `role="button"` containers: the title is a real `<button>` stretched over the container via an `::after` inset overlay; side actions ride above at z-index 1. Click-anywhere without nested-ARIA lies.

## Do's and Don'ts

### Do:
- **Do** derive every new color as a `color-mix()` over the eleven tokens; follow the percentage vocabulary (4–7% resting, 9–12% active, 18–35% selection/borders, 45% peaks).
- **Do** de-emphasize with Faintest Honest Ink (#90858b) — it clears 4.5:1 on every surface tier by construction.
- **Do** reveal hover-hidden actions on `:focus-within` too — focus landing on an invisible button is the worst of both.
- **Do** keep pointer targets ≥18px square and terminal panes ≥490×350px.
- **Do** arm consequence: two clicks, the button renames itself, rose for deletion, amber for mutation, auto-disarm.
- **Do** give every animation an honest static ending under `prefers-reduced-motion` — the frozen state must still tell the truth.
- **Do** write refusals as content that wraps in place, in full — and put raw errors behind a disclosure, not a tooltip.
- **Do** keep new UI strings in the typed bilingual catalogue (en defines the keys; zh-TW is a total map — punctuation joiners included).

### Don't:
- **Don't** introduce a twelfth color, pin Violet-Crimson to a hex, or hardcode any hex outside the tokens (the one sanctioned exception: the preview iframe's `#fff` ground and literal-black shadows).
- **Don't** put opacity on a container to de-emphasize it — it drags everything inside below AA.
- **Don't** give a resting card a colored edge: color on the edge means something is happening. A board of stripes is how state language degrades into decoration.
- **Don't** add a second attention-scale motion: the breath stays loud by being the only one. No bounce, no elastic, no cubic-bezier — this system speaks `ease`/`ease-in-out` only.
- **Don't** resize the terminal with chrome (overlays only), unmount a live terminal, or let a pane fall below the TUI's minimums.
- **Don't** load remote fonts or third-party UI kits; icons are inline one-stroke SVGs at 1em, aria-hidden, with meaning on adjacent text.
- **Don't** use uppercase letter-spacing outside small section heads, or weight 700 outside pills and tab badges.
- **Don't** show a status you didn't measure: absence of signal wears the no-signal disclaimer, blank and broken must not look alike.
