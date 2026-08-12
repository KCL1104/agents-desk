# Product

<!-- impeccable:product-schema 1 -->

This file is the authoritative record of product truth, read by humans and AI design/development tools. Items marked "confirmed 2026-08-09" are author interview answers; everything else has a source in the repo.

## Platform

web

(The desktop shell is Tauri 2 — a React + xterm.js webview over a Rust core, with SQLite for metadata. The design language is web; it belongs to no single OS. Ship targets: Linux .deb/.rpm/.AppImage, macOS AS+Intel .dmg, Windows .msi/NSIS.)

## Users

Developers who run several coding-agent CLIs at once (claude / codex / gemini / aider), managing their own agents on their own machines. The core scene is the triage loop: "an agent waits, you authorize, you move on"; the command palette is positioned as an attention inbox first, a search box second.

Confirmed 2026-08-09: this is an **open-source tool publicly seeking users**, not a personal-only project. Teams / shared boards are out of scope for now; the seat for a remote companion (the UiSink seam) is reserved in the architecture but unscheduled.

## Product Purpose

Marol is a desktop console for running and supervising multiple coding agent sessions at once. Every session is a real PTY running the real CLI, and the pane looks exactly like Terminal.app — same TUI, same `/` menu, same permission prompts. The app adds what terminal tabs cannot: managing many sessions, a list that survives restarts, and an execution environment identical to your terminal's.

What success looks like: on the board, **you know every card's state without opening a terminal**; the review loop (diff beside the live terminal, line comments, hand-editing the last line in the diff, telling the agent, merging) runs end to end without leaving the app.

## Positioning

**"Every session is a real terminal; the app does not repaint or reinterpret anything."** This is a mechanism claim neighboring products cannot truthfully copy:

- Roughly 4/5 of the category re-renders agent output as chat bubbles (Vibe Kanban, Conductor, Crystal, opcode, Happy). Marol built an SDK version first, measured it, and parked it (`src-tauri/parked/` is the evidence of the rejection, not a deletion).
- Conductor started as SDK-chat and was pushed by its users into growing a "Big Terminal Mode" — convergence evidence in reverse: the core bet is right.
- The only same-camp (real-terminal) competitor is Claude Squad, which relies on magic-string screen matching and keystroke-injection auto-approval; Marol's Claude Code hooks and per-attempt permission modes are the honest equivalents.

Distribution and licensing (confirmed 2026-08-09): free and open source under **Apache-2.0** (LICENSE added the same day). No commercial plan, no telemetry, no pricing.

## Operating Context

- Requirements: Node 20+, Rust stable, and an installed, signed-in agent CLI. Agents get the user's login-shell environment (`$SHELL -ilc`), not the GUI stub PATH.
- Three execution worlds are first-class: local, `wsl://<distro>/<path>`, `ssh://<host>/<path>`. A world is a property of the card, not a mode of the window — one desk spanning several worlds at once is an advantage over VS Code's single-remote window. Worlds are **enumerated, never invented**: WSL from `wsl.exe -l`, SSH only from the user's own `~/.ssh/config`; zero remote install, everything transits wsl.exe / ssh.
- Unit of work: Task 1—N Attempt 1—1 Session. A card names one or more repositories, and every attempt gets its own git worktree and branch **in each of them**, all on one branch name (`~/.marol/worktrees/…`, deliberately at a path you can type); one repository puts the checkout at the attempt's path, several put one directory each inside it and the session starts in that workspace. Concurrency defaults to 3, excess queues and self-starts. The worktree is the safety argument, and it survives the generalisation intact: every repository an attempt can reach is a worktree on a branch of its own, so an attempt can only ever spend its own branches — there are simply several of them now.
- Per-repo `.marol/config.json` declares setup/run/archive scripts ($MAROL_PORT / $MAROL_ROOT_PATH are part of the contract). On a card spanning several, each repository's own config runs in its own checkout; run scripts are named `<checkout>:<name>`.
- Shipping: GitHub Actions builds installers (unsigned on all platforms, workarounds documented) plus a rolling nightly prerelease. Currently v0.2.0; M1–M10b and the Tier 3 roadmap all shipped; system tray not done.
- Verification baseline: Playwright 287 passed + 8 skipped, cargo 374 green; every new Tauri command must get a handler in mock-tauri.ts.

## Capabilities and Constraints

**Shipped capabilities (M1–M10b)**: attempts with worktree isolation, four-column board, changes/activity drawer, finishing + concurrency queue, the review loop (editable diff, line comments), workspace scripts, per-attempt permission modes, named profiles, cross-session messaging (Claude v2.1.224+), WSL bridge, SSH hosts. Plus checkpoints (per-turn snapshots into private refs), park/resume, dev preview (iframe, look-not-touch), the token account, and cards that span several repositories (one workspace, one branch name, diff/review/merge covering all of them).

**Multi-agent commitment (confirmed 2026-08-09): parity is the goal.** Today's Claude-first state is honest degradation, not permanent positioning: other CLIs run, but with no hook status (no-signal chip), no auto-sent first prompt (copy, not send), no messaging. The gaps close as upstream CLIs grow measurable interfaces (hooks / structured output); until then, no guessing. **Design work must leave room for future parity — do not weld Claude-only assumptions into the layout.**

**Windows path (confirmed 2026-08-09): both native Windows and WSL get full support.** The "POSIX only for now" note on workspace scripts is a gap to close, not a product stance.

**Hard technical constraints (standing conventions; violating them means reverting):**
- The hooks iron law: never make the agent wait — work on the hook path always leaves for worker threads.
- Git state the agent can see (index, worktree, branches) is never touched on the app's own initiative; checkpoints use a temporary index + private refs.
- Never touch the agent's conversation state; restore rolls back code only.
- Status detection uses hooks only, never ANSI parsing; transient facts (token counts, preview ports) never hit disk.
- Path safety at the invoke boundary: absolute paths and `..` are rejected.

**Explicit refusals (each with a reason and a corpse)**: no chat re-render, no fake progress bars, no dollar conversion, no context percentage (no honest denominator), preview never proxied or injected, the folder-trust dialog is never bypassed, scrollback is not persisted, merge / open-PR is the end of the pipeline (no PR review/CI), no built-in browser for the preview.

## Brand Commitments

- **Name: Marol** (outward brand and bundle name; the repo slug is KCL1104/marol).
- **Language (confirmed 2026-08-09): English outward, Chinese inward.** The public face (README lead, release notes, marketing copy) is English-first; the maintainer language is zh-TW (decision docs, code comments). The product UI is fully bilingual en / zh-TW; the English catalogue is the source of truth and zh-TW is a total map (a missing key fails typecheck).
- **Voice: reasoned, measurement-first.** "Found by measurement" and "the same honesty the first prompt has" are the representative sentences. Honesty over decoration: absence over lies, and every refusal ships with its full reason.
- Existing visual constraints (recorded here, not expanded): the 11-token theme system, live WCAG contrast in the custom theme editor, 4.5:1 as the floor the app keeps for itself, no remote font loading in a desktop app.

## Evidence on Hand

- Screenshots and demo: `docs/media/{board,inspector,wall}.{en,zh}.png`, `docs/media/demo.gif` (one version shared by both READMEs). Generators: `ui/scripts/readme-gif.mjs`, `ui/tests/screenshots.spec.ts`.
- Measured numbers: checkpoints ~0.21s cold / ~0.04s warm on a 20k-file repo; ~16 WebGL contexts per browser (probed); a real session measured at 278k context (breaking any hardcoded 200k assumption); a real 22MB transcript validating the token fields.
- Decision records: eight docs in `docs/decisions/` plus `docs/frontend-patterns-research.md` (competitive research and the philosophy boundary).
- **Absent — must never be fabricated**: testimonials, star counts, enterprise adoption, pricing, benchmark rankings.

## Product Principles

1. **The real terminal is non-negotiable**: the app only carries bytes; the TUI draws itself. Any repaint or reinterpretation is out.
2. **Honesty first**: what cannot be measured is not shown; an empty space with a reason beats a guess with decoration.
3. **The app never speaks to the agent on its own**: every machine-composed message is placed in the human's hand; sending is always the human's decision.
4. **Measure before deciding**: borrowed mechanisms are unverified secondhand information until checked firsthand; every decision ships with its measurement.
5. **Restorability is the currency that buys autonomy**: worktree per attempt, checkpoints, park — a cheap way back is what earns the agent room to run.

## Accessibility & Inclusion

- The whole triage loop is keyboard-drivable (⌘E cycles waiting sessions, ⌘K palette, ⌘I inspector, J/K walk the diff, Tab/Enter act on rows/cards/diff lines); the shortcut table lives in-app at ⌘/.
- WCAG AA 4.5:1 is the contrast floor the app keeps for itself; the custom theme editor shows live contrast while it is being spent.
- aria-labels speak title + status + unseen state (separators are in the i18n catalogue too); icons are aria-hidden with meaning carried by adjacent text; every signature motion has a reduced-motion static ending.
- Focus is tested for real: tests assert document.activeElement is genuinely inside the target pane, not merely that a class is present.
