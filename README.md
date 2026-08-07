# AgentDesk

**English** · [繁體中文](README.zh-TW.md)

A desktop console for running several coding agent sessions at once. **Every
session is a real terminal** running a real `claude` (or codex / gemini / aider),
and it looks exactly like it does in Terminal.app — same TUI, same `/` menu,
same permission prompts. The app does not repaint or reinterpret anything.

What the app adds is what terminal tabs cannot give you: managing many sessions,
a list that survives restarts, and **an execution environment identical to your
terminal's** (see below).

---

## Where it is

- PTY sessions: a real pseudo-terminal running a real agent CLI, rendered by xterm.js
- Login-shell environment resolution: agents get the same PATH your terminal has
- A SQLite session list that survives restarts; reopening a session runs
  `--continue` to resume that directory's conversation
- Multiple session tabs, each keeping its own scrollback
- Any agent CLI with any launch arguments, passed through untouched
- **Status detection and notifications**, via Claude Code hooks rather than by
  parsing ANSI. The top left shows "⚠ N waiting on you", and a blocked session
  raises a native notification
- **Tasks and attempts** (M1): one card can have several attempts, each with its
  own git worktree and branch, so two agents on the same repo never collide.
  Finishing an attempt freezes its diff into the database before the worktree
  goes back
- **The board** (M2): four columns, cards drag between them. A card breathes on
  its own — sitting in "in progress" it lights up with "⚠ waiting on permission",
  and clicking it drops you into that session's TUI with the cursor already
  inside. There is a separate ad-hoc session area (off the board, with no
  worktree and no lifecycle)
- **Changes and activity** (M3): a drawer **beside** the TUI that tells you what
  this attempt changed (including uncommitted and new files) and what it did (a
  timeline of tool names and arguments) without going into the terminal. Hook
  events now land in `attempt_events` instead of being thrown away once the
  badge is computed
- **Finishing and concurrency** (M4): `merge into base`, `push + open PR` and
  `discard`. There is a limit on how many run at once (3 by default); cards over
  the limit queue up and start themselves when a slot frees
- **The review loop** (M5): click a line in the Changes drawer, attach
  feedback, and send the batch back into the still-open session — through the
  session's own terminal (bracketed paste), so a multi-line review arrives as
  **one** message, and the timeline records what was actually asked. A CLI
  whose input conventions have not been measured gets a copy button instead of
  a send button, the same honesty the first prompt has. Merging one attempt
  now marks the card's other open attempts superseded, with their diffs frozen
  so the two agents' work can still be compared afterwards
- **Workspace scripts** (M6): a fresh worktree is a checkout, not a workspace.
  `.agentdesk/config.json` in the repository says how it becomes one: `setup`
  runs before the agent starts, in the same terminal, so its output and its
  failures are exactly where you are already looking; `run` entries become ▶
  buttons in the drawer that start a dev server or test watcher in that
  attempt's own worktree, with a free port in `$AGENTDESK_PORT`; `archive`
  runs just before the worktree is taken back. Every script sees
  `$AGENTDESK_ROOT_PATH` — the repository the worktree was opened from, where
  untracked files worth copying (`.env`) live. And since one board carries
  cards from many repositories, every card now names its repo and base branch
- **Permission modes** (M7): per attempt, Claude Code can run asking as
  usual, auto-accepting file edits (`--permission-mode acceptEdits`), or
  fully unprompted (`--dangerously-skip-permissions`). The worktree is the
  safety argument — an attempt can only spend its own branch, never your
  checkout — which is why the choice exists for attempts and never for
  ad-hoc sessions. The mode is approved once in the start dialog, survives
  queueing and resumes, and the card wears a ⚡ badge while a session runs
  unprompted
- **English and 繁體中文**, following your system language and switchable from
  the environment panel. Native notifications follow the same setting

Not done yet: system tray.

---

## Making worktrees runnable

Put `.agentdesk/config.json` in a repository and every attempt's worktree
sets itself up:

```json
{
  "setup": "npm install && cp \"$AGENTDESK_ROOT_PATH/.env\" .env",
  "run": [
    { "name": "dev", "command": "npm run dev -- --port $AGENTDESK_PORT" },
    { "name": "test", "command": "npm test -- --watch" }
  ],
  "archive": "docker compose down"
}
```

Scripts run through `sh -c`, written exactly like a line in a terminal. A
malformed file fails the attempt start in the dialog rather than silently
doing nothing — a config that quietly did nothing would be indistinguishable
from a broken worktree. (POSIX platforms only for now.)

---

## Running it

You need Node 20+, Rust stable, and the agent CLI you intend to use installed
and signed in.

```bash
npm run setup
npm --prefix ui run dev &                       # vite on :5173
cargo run --manifest-path src-tauri/Cargo.toml
```

If `cargo` is not on your PATH, run `source ~/.cargo/env` first. To make it
permanent, add this to `~/.zshrc`:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

## Testing

```bash
cd src-tauri && cargo test      # PTY, hooks, worktrees, attempts, timeline, queue, migrations, rules, storage
npm --prefix ui run test:e2e    # Playwright: frontend + board + inspector + queue + xterm rendering
```

macOS ships WKWebView with no WebDriver, so Playwright runs the same React tree
in Chromium against a mocked Tauri IPC. It covers everything above the IPC
boundary — the session list, the new-session flow, and xterm's decoding and
rendering of **real PTY bytes**.

The tests check the properties that decide whether the experience is real, not
merely that something was output:

- `tests/pty.rs` — the child process is on a tty (so the CLI enters interactive
  mode rather than a degraded non-interactive one), and it gets the login
  shell's PATH rather than a GUI stub
- `tests/hooks.rs` — the whole chain: PTY → real `claude` → plugin hook → curl →
  HTTP listener, with the session id matching. No paid API call needed
- `ui/tests/fixtures/claude-tui.json` — real Claude Code TUI output captured
  from a PTY, **deliberately split in two through the middle of a multi-byte
  character**. A control test proves this fixture really does break under
  chunk-by-chunk decoding, so the main test cannot pass for the wrong reason
- `tests/prompt_injection.rs` — runs a real `claude` in a genuinely new,
  never-trusted worktree and counts how many times the `UserPromptSubmit` hook
  fires. A multi-line prompt must be **one** message, not one per line
- `tests/worktree.rs` — against real git: two attempts cannot see each other's
  files, their base_shas do not drift into one another, worktrees come back, and
  branches stay
- `tests/attempts.rs` — the whole core flow with a stub agent instead of a real
  model: what is checked is what AgentDesk did (which worktree it opened, what
  the command line looked like, what it recorded, what it gave back), none of
  which needs a model to answer. The stub's log is NUL-separated — one argument
  per line could not tell "one argument containing a newline" apart from
  "several arguments", which is exactly what is under test
- the timeline section of `tests/attempts.rs` — the whole chain: hook listener →
  router → channel → writer thread → SQLite. It also pins down what must *not*
  be recorded: three consecutive `running` reports leave the tool call and not
  three status rows
- the migration section of `store.rs` — one test per upgrade path: **an old
  database with no version but which already has `completed`** (getting this
  wrong bricks every existing install), an older one without `completed`, and a
  normal upgrade from the previous version with no data loss
- `ui/tests/queue.spec.ts` — a queued card starts itself with nobody pressing
  anything, and a merge that would lose work is refused with the reason spelled
  out in full
- `ui/tests/board.spec.ts` — the two axes really are independent: the card stays
  in its column while its light moves on its own from "waiting on folder trust"
  → "running" → "⚠ waiting on permission"; and after clicking,
  **`document.activeElement` really is inside that pane**, not merely that the
  pane has a focused class. The drag test fires all four drag events within one
  tick, which is stricter than a real drag — an implementation that only passes
  because React state happened to settle fails outright
- `ui/tests/i18n.spec.ts` — the language follows the system when nothing has
  been chosen, a stored choice beats the system, switching re-renders live and
  survives a reload, and the choice reaches the backend so native notifications
  match

The two tests that drive a real `claude` (`tests/hooks.rs` and
`tests/prompt_injection.rs`) skip themselves when there is no signed-in CLI to
drive. Being on `PATH` is not enough to check: a CLI nobody has signed into
comes up on its welcome flow and never starts a session, so the test would burn
its full timeout proving only that this machine has no login. They read
`hasCompletedOnboarding` from Claude Code's own `~/.claude.json` instead. If
that key ever moves they start skipping rather than start passing wrongly, and
the skip says why on stderr. `AGENTDESK_TEST_ASSUME_CLAUDE=1` runs them anyway.

---

## Release

Installers for all three platforms are produced by GitHub Actions
(`.github/workflows/release.yml`).

Cutting a release is one click and one decision: **Actions → Release → Run
workflow → pick a `bump`** — `patch` for fixes, `minor` for features, `major`
for breaking changes. The run computes the next version, writes it into
`tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and `package.json`, commits that
to `main`, builds all four platforms from that commit, and publishes. Nobody
maintains the version number by hand, so it moves on every release by
construction.

Then: create a draft release → build all four platforms in parallel → **publish
only when every one is green**. If a platform fails it stays a draft, so nothing
half-built ships. The version guard still protects the manual paths: pushing a
tag (or dispatching with the explicit `tag` input) fails outright unless the tag
matches `tauri.conf.json`, rather than shipping a `v0.2.0` release full of
`AgentDesk_0.1.0_*` files. The explicit `tag` input is also the recovery path —
a release that failed after its bump commit landed is re-cut with the tag it
already burned, not bumped a second time.

### Nightly builds

Every push to `main` runs the same four-platform build and publishes it to a
rolling prerelease tagged `nightly`, replacing whatever was there before. So the
newest build of `main` is always one click away without waiting for a version to
be cut:

    https://github.com/KCL1104/agents-desk/releases/tag/nightly

It is a prerelease and never marked "latest", so it cannot displace a real
version on the repo's front page or in the release API. If any platform fails,
the draft is discarded and the previous nightly stays up rather than a partial
one shipping. Pushes that land while a build is running supersede it — only the
newest commit's binaries are wanted — whereas a tag build is never cancelled.

This is why `ci.yml` does not build installers: it used to bundle three
platforms on every push to main and throw them away.

No release path pushes a tag over git: GitHub creates the tag at the built
commit when the release publishes, the same way the nightly's tag is made.
Dispatching with both inputs empty only builds — the artifacts hang off the run
and no release is touched. Every run attaches artifacts that way regardless, so
tagged and nightly builds are also downloadable from the run itself.

| Platform | Runner | Artifacts |
| --- | --- | --- |
| Linux x86_64 | `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |
| macOS Apple Silicon | `macos-15` | `.dmg`, `.app` |
| macOS Intel | `macos-15-intel` | `.dmg`, `.app` |
| Windows x86_64 | `windows-latest` | `.msi`, NSIS `.exe` |

Linux builds on 22.04 rather than 24.04 because glibc and WebKit are only
forward compatible — something built on 24.04 will not run on 22.04.
`macos-15-intel` is the last x86_64 macOS image Actions will offer; it retires
in August 2027, and the Intel row goes with it.

Only half of the `.deb` / `.rpm` dependencies appear by themselves: the bundler
reads the shared objects the executable actually links against and adds
`libwebkit2gtk-4.1-0` and `libgtk-3-0`. **`git` is not one of them** — it is
invoked at runtime through `Command::new("git")`, not linked, so nothing can
detect it. That one is written by hand in `bundle.linux.deb.depends` in
`tauri.conf.json`; without it the package installs cleanly and then falls apart
the moment you use a worktree. `gh` sits in `recommends`, since only the
open-a-PR path needs it.

### Nothing is signed

There are no signing keys in this repository, so artifacts on all three
platforms are unsigned. The first launch will be blocked:

- **macOS** — Gatekeeper says the app "is damaged and can't be opened". It is
  not damaged; that is the quarantine attribute:

  ```bash
  xattr -dr com.apple.quarantine /Applications/AgentDesk.app
  ```

- **Windows** — the blue SmartScreen dialog: "More info" → "Run anyway"
- **Linux** — nothing blocks you

To sign, add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` to the
repository secrets, then pass them through as `env` on the build step in
`release.yml` — there is a comment there marking the spot.

They are deliberately **not** wired in ahead of time. The bundler decides to sign
whenever `APPLE_CERTIFICATE` *exists*, empty value included; it never checks for a
non-empty one. Referencing a secret this repository does not have therefore sets
it to `""`, and both macOS jobs die with `failed codesign application: failed to
import keychain certificate`. Add the variables in the same change as the real
secrets, not before.

### Icons

The `.ico`, `.icns` and assorted PNGs under `src-tauri/icons/` are committed,
not generated in CI. Windows needs the `.ico` and macOS needs the `.icns`;
without one, that platform cannot produce an installer at all. To change the
artwork:

```bash
npm run tauri -- icon path/to/new-icon.png
```

Its default output directory is `src-tauri/icons/`, and it **overwrites the
source `icon.png` along with everything else**. To keep the original, send it
somewhere else with `-o` first and copy back the files you need.

---

## CI

`.github/workflows/ci.yml`. Runs on pushes to main and on every PR: Rust
`cargo test`, frontend typecheck + build + Playwright, sidecar typecheck +
build. Correctness only — packaging is release.yml's job, and a push to main
proves it by producing installers people can actually download rather than by
building them and deleting them.

`cargo fmt` and `clippy` **do not gate CI**; they only report. This tree is not
rustfmt-clean, and reformatting the whole thing is a separate change that should
not be tied to wiring up CI.

`npm run smoke` is not in CI: it opens a real Claude Code session and needs
credentials.

---

## Language

The interface ships in English and 繁體中文.

It opens in whichever your system asks for — any `zh*` locale gets Chinese,
everything else gets English — and the environment panel (bottom left) has a
picker. A choice made there always beats the system setting and is remembered
across restarts.

The webview owns the decision and pushes it down to Rust through `set_locale`,
so the handful of strings the OS renders rather than the webview — native
notification titles and bodies — follow the same setting. Two independent
detection rules that could disagree would be worse than one that is simply told.

Interface strings live in `ui/src/i18n/messages.ts`. English is the source of
truth: its keys define the `MessageKey` type and the Chinese catalogue is typed
as a total map over it, so a key added to one language and forgotten in the
other fails the typecheck rather than silently rendering a raw key on screen.
The few strings Rust renders itself are in `src-tauri/src/i18n.rs`.

Code comments are deliberately left in Chinese. They are written for whoever
works on this, not for whoever runs it, and the reasoning they carry is the most
valuable thing in the repository — translating it is a different job from making
the product bilingual.

---

## Status detection

With several sessions open, the only thing you genuinely need to know is which
one is waiting for you. That comes from asking Claude Code to report it, not
from parsing the screen — parsing ANSI breaks silently whenever the TUI changes.

At startup the app does two things: opens a small HTTP listener on loopback, and
writes a hooks-only plugin into its data directory. Every session loads it with
`--plugin-dir` and gets `AGENTDESK_SESSION_ID` / `AGENTDESK_HOOK_URL` injected;
the hook is a one-line `curl` reporting the status back.

| Hook event | Reported status |
|---|---|
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` | running |
| `PermissionRequest`, `Notification`(permission_prompt) | **waiting on permission** |
| `Notification`(idle_prompt) | **waiting on you** |
| `Stop` | idle |
| `SessionEnd` | ended |

Only "waiting on permission" and "waiting on you" raise a notification and count
towards the badge — those are the two states where the agent really is blocked
and cannot continue without you.

Three implementation landmines, all found by measurement and none of them
documented:

1. **You cannot inject hooks with `--settings`.** It overwrites keys of the same
   name, which switches your own hooks off entirely. Plugin hooks are additive.
2. **`"shell": "sh"` makes hooks silently not fire** — no error, no report.
   `"bash"` works, and so does leaving it out. There is a regression test
   pinning this.
3. **A hook must exit 0.** Exit code 2 **blocks** the tool call it is attached
   to, so every line ends with `|| true` — the app breaking must never wedge the
   agent along with it.

(Three more measured findings, about worktrees and the first prompt, are under
"Tasks and attempts" below.)

---

## Tasks and attempts

`Task 1 ─ N Attempt 1 ─ 1 Session`. An attempt is one go at a card with one
agent, carrying its own worktree and branch; switching agent and retrying means
opening a new attempt.

State has two axes, and **the second never drives the first**:

| Axis | Contents | Who decides |
|---|---|---|
| 1 · task lifecycle | `backlog → running → review → done` / `abandoned` | only a person, by dragging |
| 2 · live session status | running / ⚠ waiting on permission / ⚠ waiting on you / ⚠ waiting on folder trust / idle / ended | reported by hooks |

This follows the position `store.rs` already took with `completed`: `Stop` only
means this turn ended, not that the work is done, so no hook can move a card.

Worktrees live in `~/.agentdesk/worktrees/<repo>-<hash>/<slug>-<n>/`, **not next
to the repo** — a repo's parent directory is very often a repo itself (an
umbrella workspace), and a worktree placed there becomes a nested repo, at which
point every tool that walks upwards looking for `.git` starts giving different
answers. Nor under application support: this is a working directory that people
want to `cd` into, open in an editor and run builds in, and "a path you can
type" is worth more than "tidy".

Three more measured, undocumented facts (pinned by `tests/prompt_injection.rs`):

4. **Passing the prompt as a positional argument does not degrade into print
   mode**; `-p` does. A multi-line string passed through argv arrives as **one**
   message — a newline in argv is text, not Enter.
5. **A new worktree always hits the trust dialog, and nothing runs until it is
   answered, not even `SessionStart`.** So no hook can report this state; the
   core marks it `AwaitingTrust` directly, which it is entitled to do because it
   created that directory a moment earlier. Without this the badge misses the
   first state of every attempt. The prompt itself survives the dialog and is
   sent once you answer.
6. **`$SHELL -ilc` inherits AgentDesk's own environment.** Launched from Finder
   that is clean; launched from a terminal inside a Claude Code session it is
   not — `CLAUDE_CODE_CHILD_SESSION` switches transcript saving off, so
   `--continue` has nothing to resume and reopening an attempt silently starts
   from scratch. `shell_env` strips session markers like this, but **only the
   ones explicitly listed**: `CLAUDE_CODE_*` also houses real user settings such
   as `CLAUDE_CODE_USE_BEDROCK`, and cutting by prefix would break someone
   else's environment.

The first prompt injects only what the agent cannot discover for itself: that
this is a worktree opened for this card, which branch it is on, which base it
came from, and that commits go on this branch. CLAUDE.md, skills and MCP all
load natively and are not repeated. The template lives at
`<data_dir>/prompt-template.md`, can be edited, and upgrades do not overwrite
it. The start-attempt dialog shows the full prompt and lets you edit it, and
what is recorded is what was sent.

Non-Claude agents do not get the prompt sent automatically: those CLIs'
argument conventions have not been measured, and a flag meaning "here is your
prompt" in one can mean "print this and exit" in another. Guessing wrong is
worse than not guessing, so the UI shows the assembled prompt with a copy
button.

---

## Architecture

```
Tauri window (React + xterm.js)
      │  invoke: term_write / term_resize
      │  event:  term:output
Rust core  ── PTY registry · session list · SQLite
      │  portable-pty
  claude / codex / … × N
```

The core (`src-tauri/src/core.rs`) does not depend on Tauri; it talks outwards
only through the `UiSink` trait, so adding an axum websocket later to let a
browser or a remote client connect would not mean rewriting it.

### Why resolve the login-shell environment

A GUI program launched from Finder or the Dock gets a stripped environment:
`PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin`, with no nvm/mise/asdf shims,
no Homebrew prefix, and none of the API keys you exported. Hand that to a coding
agent and `npx`-style MCP servers fail to start — often the agent itself cannot
even be found.

`shell_env.rs` runs `$SHELL -ilc 'env -0'` once at startup and spawns every
session from your own shell's environment. The "Environment" panel at the bottom
left shows what was resolved, and says so plainly when it had to degrade.

### Terminal output is bytes, not strings

Read boundaries from the PTY land wherever the kernel decides. Decoding each
chunk as UTF-8 on the Rust side turns any multi-byte character straddling a
boundary into U+FFFD — and a TUI is full of 3-byte box-drawing characters, so
the screen splits along chunk boundaries. Output is therefore passed as base64
and handed to xterm's own stateful decoder, which stitches the boundaries back
together.

For the same reason `lineHeight` must be exactly 1. Anything greater leaves gaps
between rows, and the box-drawing characters stop joining up.

### The PTY starts producing output before the pane mounts

A PTY starts emitting bytes the moment it spawns, but the pane that displays it
does not exist until the next render. Everything in between — for Claude Code,
the entire opening screen — would go to nobody, leaving the pane blank.

So the Rust side keeps a bounded scrollback and a sequence number per session.
When a pane mounts it subscribes first (so nothing is missed), then takes a
snapshot, then writes the snapshot and replays only the live chunks newer than
it. The other order loses what arrives in between; not comparing sequence
numbers writes it twice.

### Why PTY rather than the Agent SDK

The SDK version was built first: structured events, a native message stream and
tool cards, `canUseTool` intercepting permission requests into native dialogs.
It could do more, but **the screen was no longer a terminal**. Given the goal is
"identical to a terminal", a PTY is the only thing that guarantees it — the TUI
draws itself and we only carry the bytes.

That code is parked in `src-tauri/parked/` (the Node half in `sidecar/`) rather
than deleted. If intercepting tool calls rather than merely carrying them is
ever needed — an unattended background mode, say, or a policy layer — it is a
usable starting point.

---

## Known limits

- Finishing stops at "merge" and "open PR". PR review, comments, CI status and
  the merge button are all out of scope — that is a much larger tool, and
  forcing it in here would only dilute the deepest thing this does

- Status detection only works with Claude Code. Other CLIs have no equivalent
  hook mechanism and will only show "running / closed". The first prompt is also
  only sent automatically for Claude Code; other agents get the assembled prompt
  displayed for you to paste (see above)
- The first time you open a session in a directory, Claude Code asks whether you
  trust the folder. That is its own behaviour and is deliberately not bypassed.
  **Every attempt is a new directory, so every attempt hits it once**
- Scrollback is not persisted — same as a real terminal. Conversation history is
  the agent's own (Claude Code keeps it in `~/.claude/projects/`), and reopening
  reconnects through `--continue`
- **Setting an outcome is final**: the worktree is removed, so that attempt no
  longer has a live TUI. What remains is the timeline and a frozen diff. The
  same goes for superseded attempts — "kept for reference" means read-only
  reference, not somewhere you can jump back in and type
- Closing the app kills every PTY. After a restart, cards in the `running`
  column show "not running" on the second axis and need resume pressed to come
  back (via `--continue`, without resending the prompt)
