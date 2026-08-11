/**
 * Every string the interface says, in both languages.
 *
 * `en` is the source of truth: its keys define `MessageKey`, and `zhTW` is
 * typed as a total map over that, so a key added to one language and not the
 * other fails the typecheck rather than silently rendering a raw key.
 *
 * Placeholders are `{name}` and are substituted by `t()`. They are deliberately
 * positional-free, because the two languages order their clauses differently.
 */
export const en = {
  /* ------------------------------ shared ------------------------------ */
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.open': 'Open',
  'common.create': 'Create',
  'common.start': 'Start',
  'common.choose': 'Choose…',
  'common.loading': 'Loading…',
  'common.env': 'Environment',
  /* Joiners live in the catalog: a hardcoded 、 or ， reads Chinese
     punctuation into an English sentence, and vice versa. `sep` joins
     label-and-state phrases (aria-labels); `listSep` joins list items. */
  'common.sep': ', ',
  'common.listSep': ', ',

  /* ------------------------------ boot -------------------------------- */
  'boot.node': 'Node 20+ on your login shell PATH',
  'boot.sidecar': 'The sidecar built first:',
  'boot.claude': 'Claude Code CLI installed and signed in',
  'boot.retry': 'Retry',
  'boot.resolving': 'Resolving the login shell environment…',

  /* -------------------------- new session ----------------------------- */
  'newSession.title': 'New session',
  'newSession.cwd': 'Working directory',
  'newSession.cwdHint': 'The same as {cd} into this directory and starting the agent there.',
  'newSession.args': 'Launch arguments (optional)',
  'newSession.argsHint': 'Passed to the CLI untouched, exactly as you would type them yourself.',
  'newSession.submit': 'Open terminal',

  /* ---------------------------- new card ------------------------------ */
  'newTask.title': 'New card',
  'newTask.titleLabel': 'Title (optional)',
  'newTask.titlePlaceholder': 'Fix the blank login page on Safari',
  'newTask.titleHint': 'Leave blank to use the prompt’s first line.',
  'newTask.promptLabel': 'What the agent should do',
  'newTask.promptPlaceholder':
    'The screen goes white after signing in, with no console errors. Reproduce it first, then fix it.',
  'newTask.promptHint':
    'Starting an attempt appends the branch and base — you can edit it before it is sent.',
  'newTask.repo': 'Repo',
  'newTask.repoHint': 'A local path, or wsl://<distro>/<path>, or ssh://<host>/<path>.',
  'newTask.base': 'Base branch',
  'newTask.baseHint': 'Attempts branch from here, and diff against it.',
  // 建卡成功後由 say() 唸出：對話框關掉、焦點跳到新卡片,這一刻只有
  // 視覺鏈知道發生了什麼 —— 朗讀鏈在這裡補上確認。
  'newTask.created': 'Card created: {title}',

  /* -------------------------- start attempt --------------------------- */
  'attempt.startTitle': 'Start attempt — {title}',
  'attempt.agent': 'Agent',
  'attempt.firstPrompt': 'First prompt',
  'attempt.trustHint':
    'The prompt goes out once Claude Code has asked whether you trust the new folder.',
  'attempt.unmeasuredHint':
    'We have not measured {agent}’s argument conventions, so nothing is sent automatically — a flag that means “here is your prompt” in one CLI can mean “print this and exit” in another. The session still opens; copy the text below into it.',
  'attempt.copied': 'Copied',
  'attempt.copyPrompt': 'Copy prompt',
  'attempt.openNoPrompt': 'Open session (no prompt)',
  // The fence stays in the dialog, not only in the coach mark: the mark
  // fires once, this choice is made every time. Naming the power without
  // the fence would be a scare; naming both is the consequence.
  'attempt.yoloHint':
    'No permission prompts at all — the agent runs to the end of its own judgement. The fence is the worktree: this attempt cannot touch your checkout.',

  /* -------------------------- permission modes ------------------------- */
  'mode.normal': 'Ask as usual',
  'mode.accept_edits': 'Auto-accept edits',
  'mode.yolo': 'Full auto (yolo)',

  /* ---------------------------- sidebar ------------------------------- */
  'sidebar.newSession': 'New session',
  'sidebar.waitingCount': '⚠ {count} waiting on you',
  'sidebar.empty': 'No sessions yet',
  'sidebar.markDone': 'Mark as done',
  'sidebar.unmarkDone': 'Clear done',
  'sidebar.closeTerminal': 'Close terminal',
  'sidebar.removeFromList': 'Remove from list',

  /* ---------------------------- overview ------------------------------ */
  'overview.empty': 'No sessions yet. Press + at the top left to open one.',
  'overview.noAction': 'Nothing in progress',
  'overview.noStatus': 'This agent does not report status',
  'overview.markDone': 'Done',
  'overview.unmarkDone': 'Undo done',
  /* ----------------------------- panes -------------------------------- */
  'pane.dragHint':
    'Drop on another pane’s centre to swap, on an edge to split; double-click to zoom',
  'pane.restore': 'Restore',
  'pane.zoom': 'Zoom to full',
  'pane.remove': 'Remove from layout (the session keeps running)',
  'pane.empty': 'Drag a session in from the left, or just click one',
  'pane.emptyFirstRun': 'Press ＋ at the top left to open a session, or create a card on the board',
  // 第一次的空終端牆:三行認鍵卡的說明文字。和弦本身由 chord() 依平台
  // 組出來,所以型錄裡只放「這顆鍵做什麼」。
  'pane.keymap1': 'terminal wall · board · overview',
  'pane.keymap2': 'sessions, cards, and what waits on you',
  'pane.keymap3': 'every shortcut',

  /* --------------------------- shortcuts ------------------------------ */
  'keys.title': 'Keyboard shortcuts',
  'keys.jump': 'Jump to the session waiting on you',
  'keys.palette': 'Command palette — sessions, cards, actions',
  'keys.cyclePanes': 'Focus the next / previous pane',
  'keys.moveCard': 'Move the focused board card — a column sideways, a slot up or down',
  'keys.cycleTabs': 'Next / previous tab',
  'keys.inspector': 'Open or close the inspector',
  'keys.diff':
    'J/K walk the diff lines, N/P the files; on a file header E edits, V toggles viewed; Enter acts on the focused one',
  'keys.escape': 'Close the open dialog',
  'keys.sheet': 'This list',
  'keys.shellNote':
    'In a terminal, Ctrl+letter belongs to the shell — the app’s shortcuts add Shift.',
  'attempt.modeLabel': 'Permission mode',
  'attempt.acceptHint':
    'File edits are accepted without asking; every other action still checks with you.',
  'splitter.hint': 'Drag to resize; double-click to reset to equal',
  'keys.gestures': 'Mouse and gestures',
  'gesture.pane': 'Pane header',
  'gesture.tab': 'Workspace tab',
  'gesture.tabWhat': 'Enter, F2 or a double-click renames it',
  'gesture.splitter': 'Splitter',
  'gesture.row': 'Sidebar row',
  'gesture.rowWhat': 'Drag it into the grid to place its terminal',

  /* ----------------------------- palette ------------------------------ */
  'palette.placeholder': 'Search sessions, cards, actions…',
  'palette.waiting': 'Waiting on you',
  'palette.unseen': 'Finished, unseen',
  'palette.sessions': 'Sessions',
  'palette.cards': 'Cards',
  'palette.actions': 'Actions',
  'palette.empty': 'Nothing matches',

  /* ------------------------------ tabs -------------------------------- */
  'tabs.rename': '{name} — double-click to rename',
  'tabs.waiting': 'Waiting on you',
  'tabs.unseen': 'Finished while you were away',
  'tabs.busy': 'Running',
  'tabs.close': 'Close tab (sessions stay in the sidebar)',
  'tabs.new': 'New tab',
  'tabs.defaultName': 'Workspace {n}',
  'tabs.strip': 'Workspace tabs',

  /* --------------------------- column picker -------------------------- */
  'cols.label': 'Columns',
  'cols.auto': 'Auto',
  'cols.one': '1 col',
  'cols.n': '{n} cols',
  'cols.custom': 'Custom',
  'cols.manualHint':
    'This tab’s layout is one you arranged; choosing anything else reverts it to automatic',
  'cols.autoHint': 'Choose the column count from the window width',

  /* ------------------------------ board ------------------------------- */
  'board.newCard': 'New card',
  'board.emptyBacklog': 'Press ＋ to add a card',
  // 整張桌子還沒有任何卡片時,CTA 說完整的一句 —— 第一分鐘值得一個
  // 完整的句子;桌子用過之後,短標籤就夠了。
  'board.emptyBacklogFirst': 'Add the first card — a repo, a branch, something to do',
  'board.emptyDrop': 'Drag a card here',
  'board.adHoc': 'Ad-hoc sessions',
  'board.adHocEmpty': 'No ad-hoc sessions.',
  'board.concurrency': 'Running at once',
  'board.less': 'Lower the concurrency limit',
  'board.more': 'Raise the concurrency limit',
  'board.queued': '· {count} queued',
  'board.start': 'Start',
  'board.cancelQueue': 'Leave the queue',
  'board.resume': 'Resume',
  'board.inspect': 'Inspect',
  'board.retry': 'Try again',
  'board.switchAgent': 'Switch agent',
  'board.retryHint': 'Open another attempt with a different agent',
  'board.deleteCard': 'Delete card',
  'board.confirmDelete': 'Delete for good?',
  'board.deleteBusy': 'The agent is mid-turn — deleting would take its session and worktree. Wait for it to settle, or park first.',
  'board.movedTo': '{title} moved to {col}',
  'board.reordered': '{title} moved to position {n}',
  // 螢幕閱讀器聽的「⚠」:卡片的 aria-label 用這個詞,不用圖形字元 ——
  // 朗讀器對 ⚠ 的處理不可靠,一個真正的詞才保證被唸出來。
  'board.needsYou': 'needs you',
  'announce.multi': '{count} sessions waiting on you: {titles}',
  'announce.finished': '{title} finished a turn',
  'err.notDir': 'This path does not exist (or is not a folder). Check it, or pick the repository with Choose.',
  'err.notGitRepo': 'That folder is not a git repository. Point the card at the repo root — the folder holding .git.',
  'err.noBranch': 'The repository has no branch named "{branch}". Check the base branch name — it is often main or master.',
  'err.details': 'Details',
  'env.diagnostics': 'Diagnostics',
  'sidebar.title': 'Sessions',
  'toast.more': '{count} earlier — clear all',

  /* ----------------------------- theme -------------------------------- */
  'env.theme': 'Theme',
  'theme.ink': 'Ink',
  'theme.paper': 'Paper',
  'theme.pine': 'Pine',
  'theme.wisteria': 'Wisteria',
  'theme.sunset': 'Sunset',
  'theme.custom': 'Custom',
  'theme.customHint':
    'The rest derive. Chips measure each text tier against its surface — 4.5 is the floor.',
  'theme.bg': 'Background',
  'theme.fg': 'Text',
  'theme.accent': 'Accent',
  'theme.ok': 'OK',
  'theme.warn': 'Warning',
  'theme.err': 'Error',
  'theme.light': 'Light theme (terminals use a light ANSI ramp)',
  'theme.cText': 'Body',
  'theme.cDim': 'Secondary',
  'theme.cFaint': 'Faintest',
  'theme.cAccent': 'Primary button',

  /* ---------------------------- lifecycle ----------------------------- */
  'lifecycle.backlog': 'Backlog',
  'lifecycle.running': 'In progress',
  'lifecycle.review': 'Review',
  'lifecycle.done': 'Done',
  'lifecycle.abandoned': 'Abandoned',

  /* ----------------------------- outcome ------------------------------ */
  'outcome.merged': 'Merged',
  'outcome.discarded': 'Discarded',
  'outcome.superseded': 'Superseded',

  /* ------------------------------ live -------------------------------- */
  'live.notStarted': 'Not started',
  'live.queued': 'Queued · #{position}',
  'live.stopped': 'Not running',
  'live.parked': 'Parked',
  'live.ended': 'Ended',

  /* ----------------------------- status ------------------------------- */
  'status.starting': 'Starting',
  'status.awaiting_trust': 'Waiting on folder trust',
  'status.running': 'Running',
  'status.waiting_permission': 'Waiting on permission',
  'status.waiting_input': 'Waiting on you',
  'status.idle': 'Idle',
  'status.saved': 'Closed',
  'status.exited': 'Exited',
  // Worn by cards whose agent has no hooks: silence that means "can't
  // tell", kept distinct from silence that means "nothing to do".
  'status.noSignal': 'no status signal',

  /* ----------------------------- sections ----------------------------- */
  'section.working': 'Working',
  'section.waiting': 'Waiting on you',
  'section.idle': 'Idle',
  'section.done': 'Done',

  /* ------------------------------ unseen ------------------------------ */
  'unseen.label': 'finished, not yet seen',

  /* ----------------------------- welcome ------------------------------ */
  'welcome.title': 'Welcome to AgentDesk',
  'welcome.found': 'What this machine has',
  'welcome.model': 'How it works',
  'welcome.model1': 'A card is a repo, a base branch, and something to do.',
  'welcome.model2':
    'Starting an attempt opens an isolated git worktree with a real terminal — the agent can only touch its own branch, never your checkout.',
  'welcome.model3':
    'Finishing merges the branch back, opens a PR, or discards it. Either way the diff is frozen and kept.',
  'welcome.newCard': 'Create the first card',
  'welcome.newSession': 'Open an ad-hoc session',
  'welcome.reopen': 'Show the welcome panel',
  // The interface says what a control does; the README says why. This is the
  // door to it — without one, shortening the interface loses the reason.
  'env.docs': 'Documentation',
  // 一台沒有任何 agent CLI 的機器:卡片照開,attempt 需要 CLI ——
  // 界線照實說,不假裝一切就緒,也不擋人建卡。
  'welcome.noAgents':
    'No agent CLI found on this shell’s PATH. Cards can be made now; starting an attempt needs claude, codex, gemini or aider installed and signed in.',
  'welcome.probeAgain': 'Probe again',

  /* ------------------------------ coach ------------------------------- */
  'coach.gotIt': 'Got it',
  'coach.attempt.title': 'This attempt has its own worktree',
  'coach.attempt.body':
    'Every attempt opens an isolated branch and folder from the base — the agent only ever touches its own copy. A brand-new folder makes Claude Code ask for trust first; the prompt goes out once you answer.',
  'coach.mode.title': 'This session will ask less',
  'coach.mode.body':
    'With fewer prompts, the agent runs on its own judgement. The safety boundary is the worktree: it can only spend this attempt’s branch, never your checkout. The card and the pane wear the badge the whole time.',
  'coach.finish.title': 'Finishing is final',
  'coach.finish.body':
    'Merge folds the branch back and takes the worktree; discard takes it too. Both freeze the diff first, so the record survives — but nothing here can be reopened to type into. To compare agents, start a second attempt before deciding.',
  'coach.terminal.title': 'This is a real terminal',
  'coach.terminal.body':
    'Ctrl+letter belongs to the shell in here — the app’s shortcuts take Shift (Ctrl+Shift+E), the way Ctrl+Shift+C copies. ⌘/Ctrl+Alt+←→ moves between panes; ⌘/Ctrl+1/2/3 switches views.',
  'coach.waiting.title': 'An agent is waiting on you',
  // {jump} 由 CoachMark 依平台代入(⌘E / Ctrl+E)—— coach 教的是
  // 「現在就按這顆」,不是規則表。
  'coach.waiting.body':
    'The amber breath means a human is needed — nothing else on the desk pulses. {jump} jumps to whoever waits; the question in the pane is the CLI’s own, so answer it there.',

  /* ------------------------------ stats ------------------------------- */
  'stats.ahead': '{n} commits {branch} does not have yet',
  'stats.behind': '{branch} has moved on by {n} commits — rebase before merging',
  'stats.hint': 'Lines changed vs {branch} · ↑ commits ahead · ↓ commits behind',

  /* ---------------------------- inspector ----------------------------- */
  'inspector.changes': 'Changes',
  'inspector.activity': 'Activity',
  'inspector.reload': 'Reload',
  'inspector.closeView': 'Close inspector',
  'inspector.frozen': 'Frozen',
  'inspector.mergeInto': 'Merge into {branch}',
  'inspector.merged': 'Merged into {branch}',
  'inspector.confirmDiscard': 'Discard for good?',
  'inspector.confirmMerge': 'Really merge into {branch}?',
  'inspector.working': 'Working…',
  'inspector.frozenHint':
    'Ended. The changes are frozen and kept; nothing here can change them.',
  'inspector.openPr': 'Push + open PR',
  'inspector.discard': 'Discard',
  'inspector.discardHint': 'Take the worktree back — the diff is frozen and kept.',
  'inspector.noChanges': 'This attempt has not changed any files yet.',
  'inspector.noActivity': 'No activity yet. Status reporting only works with Claude Code.',
  'inspector.eventsFailed': 'Could not read the activity: {err}',
  'inspector.diffSummary': '{files} files',
  'inspector.readAt': 'read {time}',
  'inspector.copyUrl': 'Copy link',
  'inspector.jumpLabel': 'Jump to a file',
  'inspector.viewedCount': '· viewed {seen}/{files}',
  'inspector.wrap': 'Wrap long lines',
  'inspector.markViewed': 'Mark as viewed — folds it away',
  'inspector.unmarkViewed': 'Viewed — click to take it back',
  'inspector.resize': 'Drag to resize; ← wider, → narrower',

  /* --------------------------- next action ----------------------------- */
  'next.commit': 'Uncommitted changes — a merge now would not include them',
  'next.rebase': '{branch} has moved on by {n} — rebase before merging',
  'next.finish': 'Clean and ahead — ready to merge into {branch} or open a PR',
  'inspector.runHint': 'Run `{name}` in this attempt’s worktree, in its own terminal',
  'inspector.worktreeGroup': 'worktree',
  'inspector.shell': 'shell',
  'inspector.shellHint': 'Your own shell in this attempt’s worktree',
  'inspector.queued': 'A message is holding for the end of this turn',
  'inspector.cancelQueued': 'Cancel it',
  'timeline.waited': '· held {for}',

  /* ----------------------------- review ------------------------------- */
  'review.hint': 'Click to attach feedback to this line',
  'review.placeholder': 'What should change here?',
  'review.add': 'Add feedback',
  'review.remove': 'Remove this feedback',
  'review.send': 'Send {count} back to the agent',
  'review.queue': 'Send {count} when this turn ends',
  'review.copy': 'Copy feedback',
  'review.header': '[AgentDesk review] Feedback on the current diff:',
  'review.footer': 'Please address each point above, then commit on this branch.',

  /* ------------------------------ env --------------------------------- */
  'env.shell': 'shell',
  'env.source': 'environment source',
  'env.sourceLogin': 'login shell ✓',
  // Windows: the process env *is* the user's real environment — no shell
  // probe happens and nothing is degraded.
  'env.sourceSystem': 'system environment ✓',
  'env.sourceProcess': 'process env (degraded)',
  'env.varCount': 'variables',
  'env.claude': 'claude',
  'env.claudeMissing': 'not found',
  'env.db': 'database',
  'env.degraded':
    'Could not read the login shell environment, so this process’s own was used instead. npx-style MCP servers may fail to start.',
  'env.language': 'Language',
  'env.messaging': 'Cross-session messaging',
  'env.messagingOff': 'needs Claude Code ≥ 2.1.224 (found {version})',
  'env.profiles': 'Agent profiles',
  'env.profilesHint': 'A CLI plus the flags it always gets. Profiles appear in both launch dialogs.',
  'env.notifications': 'Notifications',
  'notify.hint': 'Raised only while the window is elsewhere.',
  'notify.permission': 'Permission and folder-trust prompts',
  'notify.input': 'Waiting on your reply',
  'notify.done': 'A turn finished',
  'notify.test': 'Send a test notification',
  'notify.sent': 'Sent ✓',

  /* ------------------- terminal screen reader mode --------------------- */
  'env.termSr': 'Terminal screen reader mode',
  // Kept long on purpose: a trade the person is about to make, stated in
  // full. What gets cut from this catalogue is teaching, never disclosure.
  'termSr.hint':
    'Every terminal, permission prompts included, becomes readable to a screen reader. The trade: no GPU rendering, so heavy output scrolls less smoothly.',
  'termSr.toggle': 'Expose terminal text to screen readers',

  /* --------------------------- checkpoints ----------------------------- */
  'env.checkpoints': 'Checkpoints',
  // Every clause here is a guarantee about what is touched and what is not.
  // The "why a retreat is worth having" half moved to the README.
  'ckpt.hint':
    'Snapshots the worktree at each turn’s end. Kept in private refs, deleted when the attempt ends; the agent’s own git state is never touched.',
  'ckpt.onStop': 'Snapshot when a turn ends (Claude Code sessions)',
  'inspector.ckpt': 'Checkpoint',
  'inspector.ckptHint': 'Snapshot this worktree now — any agent, any moment',
  'inspector.ckptMade': 'Kept #{n} ✓',
  'inspector.ckptNone': 'Nothing new since the last one',
  'ckpt.restoreHint': 'Restore the worktree to before this turn — code only, the conversation stays',
  'ckpt.restoreArm': 'Restore to before this turn?',
  'ckpt.blocked': 'The agent is mid-turn; wait for it to end — or close the session — to restore',
  'ckpt.restored': 'Restored to checkpoint #{n}. The pre-restore state was snapshotted first.',
  'ckpt.restoredBase': 'Restored to the attempt’s base. The pre-restore state was snapshotted first.',
  'ckpt.tell': 'Tell the agent',
  'ckpt.note':
    'Note: this worktree was restored to an earlier checkpoint. Files may not match what you last wrote — re-read anything before editing it.',
  'board.park': 'Park',
  'board.parkHint':
    'Give the worktree and the slot back — branch, checkpoints and conversation all stay',
  'park.done': 'Parked. Branch {branch} is on the clipboard — the work and the conversation are kept.',
  'park.restoreFailed':
    'Resumed, but the parked work did not come down cleanly: {err}. The worktree is on its branch — restore from the timeline.',
  'park.restoreParked': 'Parked — resume first, then restore',
  /* ---------------------------- preview ------------------------------ */
  'preview.title': 'Dev server preview',
  'preview.open': 'Preview',
  'preview.openHint': 'See the dev server beside the desk — the page exactly as it serves it',
  'preview.sshHint':
    'The server runs on the remote host, so its port is not reachable from here. Open a tunnel of your own, or a browser on that machine.',
  'preview.copy': 'Copy',
  'preview.reload': 'Reload the page',
  'preview.external': 'Open in the browser',
  'preview.dead': 'The server has ended — its terminal closed.',
  'preview.notListening': 'Nothing is answering at {url} yet.',
  'preview.retry': 'Check again',
  'preview.close': 'Close the preview',
  'preview.pick': '{component} — {file}:{line}',
  'preview.note':
    'In the preview I am pointing at {component} ({file}:{line}) — the next feedback is about this element.',
  'ckpt.timelineHint': 'Every prompt row carries ↩ — restore the code to before that turn.',
  'inspector.diffKeys': 'j/k lines · n/p files · e edit · v viewed · Enter comment',
  'ckpt.compare': 'Against',
  'ckpt.compareBase': 'Base — the whole attempt',
  'ckpt.compareN': 'Checkpoint #{n} · {time}',
  /* -------------------------- editable diff --------------------------- */
  'edit.chip': 'edit',
  'edit.hint': 'Edit this file in place — saving writes into the attempt’s worktree',
  'edit.oneAtATime': 'One file at a time — save or close the open editor first',
  'edit.save': 'Save',
  'edit.saveHint': 'Write this text into {file} (⌘S)',
  'edit.saved': 'Saved ✓',
  'edit.close': 'Close',
  'edit.note': 'I hand-edited {file} — re-read it before continuing.',
  'edit.failed': 'Could not read {file}: {err}',
  'edit.discardTitle': 'Unsaved changes',
  'edit.discardBody': 'Close the editor and lose the edits to {file}?',
  'edit.discard': 'Discard the edits',
  'edit.keep': 'Keep editing',
  'edit.compareLocked': 'Close the editor to switch the baseline',
  'review.stale': 'line changed',
  'review.staleHint':
    'The quoted line is no longer in the diff — the note still sends, quoting what you saw.',
  /* ----------------------------- worlds ------------------------------- */
  'world.local': 'This machine',
  'world.where': 'World',
  'world.pick': 'Where new cards and sessions open — WSL distros and SSH hosts included',
  'world.hint': 'New cards and sessions open here. Each card keeps its own world.',
  'world.probing': 'reaching…',
  'world.noClaude': 'no claude on this world’s PATH',
  /* ------------------------ find in terminal -------------------------- */
  'term.find': 'Find in terminal',
  'term.findHint': 'Enter finds the next match, Shift+Enter the previous, Esc closes',
  'term.prev': 'Previous match',
  'term.next': 'Next match',
  'term.noMatch': 'No match',
  'keys.find': 'Find in the focused terminal (from inside it: Ctrl+Shift+F)',
  /* --------------------------- token account -------------------------- */
  'usage.line': 'context {ctx} · output {out}',
  // Four measured numbers and where they came from — the disclosure is the
  // point of the tooltip, so it stays; the essay around it went.
  'usage.tip':
    'Read from the transcript at each turn’s end. Context {context} is the last request’s prompt. Cumulative: {input} in · {output} out · {write} cache-written · {read} cache-read.',

  /* ----------------------------- profiles ------------------------------ */
  'profile.namePlaceholder': 'opus, quiet claude, …',
  'profile.add': 'Add profile',
  'profile.remove': 'Remove this profile',
  'profile.save': 'Save profiles',
  'profile.saved': 'Saved ✓',

  /* ------------------------------ views ------------------------------- */
  'view.overview': 'Overview',
  'view.board': 'Board',
  'view.noSession': 'No sessions yet',
  'view.inspector': 'Inspector',
  'view.terminal': 'Terminal',

  /* ------------------------------ errors ------------------------------ */
  'error.updateTab': 'Could not update the tab: {err}',
  'error.openSession': 'Could not open the session: {err}',
  'error.reopen': 'Could not reopen: {err}',
  'error.resumeAttempt': 'Could not resume the attempt: {err}',
  'error.moveCard': 'Could not move the card: {err}',
  'error.cancelQueue': 'Could not leave the queue: {err}',
  'error.park': 'Could not park the attempt: {err}',
  'error.deleteCard': 'Could not delete the card: {err}',
  'error.newTab': 'Could not add the tab: {err}',
  'error.runScript': 'Could not start the run script: {err}',
  'error.openShell': 'Could not open the worktree shell: {err}',
} as const;

export type MessageKey = keyof typeof en;

export const zhTW: Record<MessageKey, string> = {
  /* ------------------------------ shared ------------------------------ */
  'common.cancel': '取消',
  'common.close': '關閉',
  'common.open': '開啟',
  'common.create': '建立',
  'common.start': '開始',
  'common.choose': '選擇…',
  'common.loading': '讀取中…',
  'common.env': '環境',
  'common.sep': '，',
  'common.listSep': '、',

  /* ------------------------------ boot -------------------------------- */
  'boot.node': 'Node 20+ 必須在你的 login shell PATH 上',
  'boot.sidecar': 'sidecar 要先建置：',
  'boot.claude': 'Claude Code CLI 必須已安裝並登入',
  'boot.retry': '重試',
  'boot.resolving': '正在解析 login shell 環境…',

  /* -------------------------- new session ----------------------------- */
  'newSession.title': '新 session',
  'newSession.cwd': '工作目錄',
  'newSession.cwdHint': '等同於 {cd} 到這裡再開 agent。',
  'newSession.args': '啟動參數（可留空）',
  'newSession.argsHint': '原封不動傳給 CLI，跟你自己在終端機打的一樣。',
  'newSession.submit': '開啟終端機',

  /* ---------------------------- new card ------------------------------ */
  'newTask.title': '新卡片',
  'newTask.titleLabel': '標題（選填）',
  'newTask.titlePlaceholder': '修好登入頁在 Safari 的白畫面',
  'newTask.titleHint': '留白就用 prompt 的第一行。',
  'newTask.promptLabel': '要 agent 做什麼',
  'newTask.promptPlaceholder': '登入後畫面全白，console 沒有錯誤。先重現再修。',
  'newTask.promptHint': '開 attempt 時會補上分支與 base —— 送出前可以改。',
  'newTask.repo': 'Repo',
  'newTask.repoHint': '本機路徑，或 wsl://<distro>/<路徑>，或 ssh://<host>/<路徑>。',
  'newTask.base': 'Base 分支',
  'newTask.baseHint': 'attempt 從這裡開分支，diff 也以這裡為基準。',
  'newTask.created': '已建立卡片：「{title}」',

  /* -------------------------- start attempt --------------------------- */
  'attempt.startTitle': '開始 attempt — {title}',
  'attempt.agent': 'Agent',
  'attempt.firstPrompt': '首則 prompt',
  'attempt.trustHint': 'Claude Code 會先問你信不信任這個新資料夾，答完 prompt 才送出。',
  'attempt.unmeasuredHint':
    '{agent} 的參數慣例我們沒有實測過，所以不會自動送出 —— 在某個 CLI 代表「這是你的 prompt」的參數，在另一個可能代表「印出來然後結束」。session 照樣會開，把下面這段複製貼進去即可。',
  'attempt.copied': '已複製',
  'attempt.copyPrompt': '複製 prompt',
  'attempt.openNoPrompt': '開 session（不送 prompt）',
  'attempt.yoloHint':
    '完全不再詢問權限 —— agent 全憑自己的判斷跑到底。圍籬是 worktree：這個 attempt 碰不到你的 checkout。',

  /* -------------------------- permission modes ------------------------- */
  'mode.normal': '照常詢問',
  'mode.accept_edits': '自動接受檔案編輯',
  'mode.yolo': '全自動（yolo）',

  /* ---------------------------- sidebar ------------------------------- */
  'sidebar.newSession': '新 session',
  'sidebar.waitingCount': '⚠ {count} 個等你',
  'sidebar.empty': '還沒有 session',
  'sidebar.markDone': '標記為完成',
  'sidebar.unmarkDone': '取消完成標記',
  'sidebar.closeTerminal': '關閉終端機',
  'sidebar.removeFromList': '從清單移除',

  /* ---------------------------- overview ------------------------------ */
  'overview.empty': '還沒有 session。按左上角 + 開一個。',
  'overview.noAction': '沒有進行中的動作',
  'overview.noStatus': '這個 agent 不回報狀態',
  'overview.markDone': '完成',
  'overview.unmarkDone': '取消完成',

  /* ----------------------------- panes -------------------------------- */
  'pane.dragHint': '拖到別的 pane 中央可對調，拖到邊緣可切分；雙擊放大',
  'pane.restore': '還原',
  'pane.zoom': '放大到滿版',
  'pane.remove': '從佈局移除（session 繼續執行）',
  'pane.empty': '把 session 從左側拖進來，或直接點選',
  'pane.emptyFirstRun': '按左上角的＋開新 session，或到看板開一張卡片',
  'pane.keymap1': '終端牆 · 看板 · 總覽',
  'pane.keymap2': 'session、卡片、和在等你的',
  'pane.keymap3': '全部快捷鍵',

  /* --------------------------- shortcuts ------------------------------ */
  'keys.title': '鍵盤快捷鍵',
  'keys.jump': '跳到正在等你的 session',
  'keys.palette': '命令面板 —— session、卡片、動作',
  'keys.cyclePanes': '聚焦下一個 / 上一個 pane',
  'keys.moveCard': '搬動聚焦的卡片 —— 左右換欄、上下換位',
  'keys.cycleTabs': '下一個 / 上一個分頁',
  'keys.inspector': '開關檢視器',
  'keys.diff': 'J/K 逐行、N/P 逐檔；檔頭上 E 編輯、V 切換已看；Enter 對聚焦處動作',
  'keys.escape': '關閉打開的對話框',
  'keys.sheet': '這份清單',
  'keys.shellNote': '在終端機裡，Ctrl+字母屬於 shell —— app 的手勢要多按 Shift。',
  'attempt.modeLabel': '權限模式',
  'attempt.acceptHint': '檔案編輯不再逐次詢問；其他動作照樣先問你。',
  'splitter.hint': '拖曳調整比例；雙擊還原等分',
  'keys.gestures': '滑鼠與手勢',
  'gesture.pane': 'Pane 標頭',
  'gesture.tab': '工作區分頁',
  'gesture.tabWhat': 'Enter、F2 或雙擊都可改名',
  'gesture.splitter': '分隔線',
  'gesture.row': '側欄列',
  'gesture.rowWhat': '拖進網格，把它的終端機放上畫面',

  /* ----------------------------- palette ------------------------------ */
  'palette.placeholder': '搜尋 session、卡片、動作…',
  'palette.waiting': '等你',
  'palette.unseen': '完成未看',
  'palette.sessions': 'Sessions',
  'palette.cards': '卡片',
  'palette.actions': '動作',
  'palette.empty': '沒有符合的',

  /* ------------------------------ tabs -------------------------------- */
  'tabs.rename': '{name} — 雙擊改名',
  'tabs.waiting': '等你處理',
  'tabs.unseen': '趁你不在時完成了',
  'tabs.busy': '執行中',
  'tabs.close': '關閉分頁（session 會留在側邊欄）',
  'tabs.new': '新分頁',
  'tabs.defaultName': '工作 {n}',
  'tabs.strip': '工作區分頁',

  /* --------------------------- column picker -------------------------- */
  'cols.label': '欄數',
  'cols.auto': '自動',
  'cols.one': '1 欄',
  'cols.n': '{n} 欄',
  'cols.custom': '自訂',
  'cols.manualHint': '這個分頁的佈局是你自己排的；選其他值會還原成自動',
  'cols.autoHint': '依視窗寬度自動決定欄數',

  /* ------------------------------ board ------------------------------- */
  'board.newCard': '新增卡片',
  'board.emptyBacklog': '按 ＋ 新增卡片',
  'board.emptyBacklogFirst': '開第一張卡 —— 一個 repo、一個分支、一件要做的事',
  'board.emptyDrop': '把卡片拖到這裡',
  'board.adHoc': '臨時 session',
  'board.adHocEmpty': '沒有臨時 session。',
  'board.concurrency': '同時執行',
  'board.less': '減少同時執行數',
  'board.more': '增加同時執行數',
  'board.queued': '· {count} 個排隊中',
  'board.start': '開始',
  'board.cancelQueue': '離開佇列',
  'board.resume': '繼續',
  'board.inspect': '檢視',
  'board.retry': '再試一次',
  'board.switchAgent': '換 agent',
  'board.retryHint': '用另一個 agent 再開一個 attempt',
  'board.deleteCard': '刪除卡片',
  'board.confirmDelete': '確定刪除？',
  'board.deleteBusy': 'agent 回合進行中 —— 刪除會連 session 和 worktree 一起帶走。等它安靜下來，或先暫停。',
  'board.movedTo': '{title} 移到 {col}',
  'board.reordered': '{title} 移到第 {n} 位',
  'board.needsYou': '需要你',
  'announce.multi': '{count} 個 session 等你：{titles}',
  'announce.finished': '「{title}」回合結束',
  'err.notDir': '這個路徑不存在（或不是資料夾）。檢查一下，或用「選擇」挑選 repository。',
  'err.notGitRepo': '這個資料夾不是 git repository。請指向 repo 根目錄 —— 也就是有 .git 的那層。',
  'err.noBranch': 'Repository 裡沒有叫「{branch}」的分支。確認 base 分支名稱 —— 通常是 main 或 master。',
  'err.details': '詳細',
  'env.diagnostics': '診斷',
  'sidebar.title': 'Sessions',
  'toast.more': '還有 {count} 則較早的 — 全部清除',

  /* ----------------------------- theme -------------------------------- */
  'env.theme': '主題',
  'theme.ink': '墨',
  'theme.paper': '紙',
  'theme.pine': '松',
  'theme.wisteria': '紫藤',
  'theme.sunset': '落日',
  'theme.custom': '自訂',
  'theme.customHint':
    '其餘層次由此推導。色片量的是每一階文字對它所在的底色 —— 4.5 是樓地板。',
  'theme.bg': '背景',
  'theme.fg': '文字',
  'theme.accent': '強調色',
  'theme.ok': '成功',
  'theme.warn': '警告',
  'theme.err': '錯誤',
  'theme.light': '淺色主題（終端機改用淺色 ANSI 色盤）',
  'theme.cText': '內文',
  'theme.cDim': '次要',
  'theme.cFaint': '最淡',
  'theme.cAccent': '主要按鈕',

  /* ---------------------------- lifecycle ----------------------------- */
  'lifecycle.backlog': '待辦',
  'lifecycle.running': '進行中',
  'lifecycle.review': '待驗收',
  'lifecycle.done': '完成',
  'lifecycle.abandoned': '已放棄',

  /* ----------------------------- outcome ------------------------------ */
  'outcome.merged': '已合併',
  'outcome.discarded': '已丟棄',
  'outcome.superseded': '已被取代',

  /* ------------------------------ live -------------------------------- */
  'live.notStarted': '尚未開始',
  'live.queued': '排隊中 · 第 {position} 個',
  'live.stopped': '未執行',
  'live.parked': '已暫停',
  'live.ended': '已結束',

  /* ----------------------------- status ------------------------------- */
  'status.starting': '啟動中',
  'status.awaiting_trust': '等你確認資料夾',
  'status.running': '執行中',
  'status.waiting_permission': '等你授權',
  'status.waiting_input': '等你回覆',
  'status.idle': '待命',
  'status.saved': '已關閉',
  'status.exited': '已結束',
  'status.noSignal': '無狀態訊號',

  /* ----------------------------- sections ----------------------------- */
  'section.working': '開發中',
  // 與 ⚠ 徽章同一個詞：這一區裝的正是徽章數的那些列。
  'section.waiting': '等你',
  'section.idle': '待命',
  'section.done': '已完成',

  /* ------------------------------ unseen ------------------------------ */
  'unseen.label': '已完成，還沒看過',

  /* ----------------------------- welcome ------------------------------ */
  'welcome.title': '歡迎使用 AgentDesk',
  'welcome.found': '這台機器上找到的',
  'welcome.model': '怎麼運作',
  'welcome.model1': '一張卡片 = 一個 repo、一個 base 分支、一件要做的事。',
  'welcome.model2':
    '開始 attempt 會開一個隔離的 git worktree 和一個真終端 —— agent 只碰得到自己的分支，碰不到你的 checkout。',
  'welcome.model3': '結束時把分支合回去、開 PR、或丟棄。無論哪種，diff 都會先凍結保留。',
  'welcome.newCard': '開第一張卡',
  'welcome.newSession': '先開個臨時 session',
  'welcome.reopen': '顯示歡迎面板',
  'env.docs': '說明文件',
  'welcome.noAgents':
    '這個 shell 的 PATH 上找不到任何 agent CLI。卡片現在就能開；要開始 attempt，需要先安裝並登入 claude、codex、gemini 或 aider。',
  'welcome.probeAgain': '重新偵測',

  /* ------------------------------ coach ------------------------------- */
  'coach.gotIt': '知道了',
  'coach.attempt.title': '這個 attempt 有自己的 worktree',
  'coach.attempt.body':
    '每次開始都會從 base 分支開一個隔離的分支和資料夾 —— agent 只動得到它自己的這份。全新的資料夾會先觸發 Claude Code 的信任確認；答完，prompt 才送出。',
  'coach.mode.title': '這個 session 會少問你',
  'coach.mode.body':
    '減少詢問之後，agent 憑自己的判斷往下跑。安全邊界是 worktree：它只花得掉這個 attempt 自己的分支，碰不到你的 checkout。卡片和 pane 會一直戴著這個徽章。',
  'coach.finish.title': '結束是最終的',
  'coach.finish.body':
    '合併會把分支收回 base 並收回 worktree；丟棄也一樣。兩者都會先凍結 diff，紀錄留得下來 —— 但之後只能讀，不能再進去改。想比較兩個 agent，先開第二個 attempt 再做決定。',
  'coach.terminal.title': '這是一個真終端',
  'coach.terminal.body':
    '在這裡 Ctrl+字母屬於 shell —— app 的快捷鍵要加 Shift（Ctrl+Shift+E），就像 Ctrl+Shift+C 是複製。⌘/Ctrl+Alt+←→ 在 pane 之間移動；⌘/Ctrl+1/2/3 切換視圖。',
  'coach.waiting.title': '有 agent 在等你',
  'coach.waiting.body':
    '琥珀色的呼吸代表需要人 —— 桌上不會有別的東西這樣跳動。{jump} 跳到在等的那個；pane 裡的問題是 CLI 自己問的，就在裡面回答。',

  /* ------------------------------ stats ------------------------------- */
  'stats.ahead': '有 {n} 個 {branch} 還沒有的 commit',
  'stats.behind': '{branch} 已經前進了 {n} 個 commit —— 合併前先 rebase',
  'stats.hint': '相對 {branch} 的行數變更 · ↑ 領先的 commit · ↓ 落後的 commit',

  /* ---------------------------- inspector ----------------------------- */
  'inspector.changes': '變更',
  'inspector.activity': '活動',
  'inspector.reload': '重新讀取',
  'inspector.closeView': '關閉檢視',
  'inspector.frozen': '已凍結',
  'inspector.mergeInto': '合併回 {branch}',
  'inspector.merged': '已合併回 {branch}',
  'inspector.confirmDiscard': '確定丟棄？',
  'inspector.confirmMerge': '確定合併回 {branch}？',
  'inspector.working': '處理中…',
  'inspector.frozenHint': '已結束。變更凍結保留，這裡不會再改動它。',
  'inspector.openPr': 'push + 開 PR',
  'inspector.discard': '丟棄',
  'inspector.discardHint': '收回 worktree —— diff 會凍結保留。',
  'inspector.noChanges': '這個 attempt 還沒有改動任何檔案。',
  'inspector.noActivity': '還沒有活動。狀態回報只對 Claude Code 有效。',
  'inspector.eventsFailed': '讀取活動失敗：{err}',
  'inspector.diffSummary': '{files} 個檔案',
  'inspector.readAt': '{time} 讀取',
  'inspector.copyUrl': '複製連結',
  'inspector.jumpLabel': '跳到檔案',
  'inspector.viewedCount': '· 已看 {seen}/{files}',
  'inspector.wrap': '長行折行',
  'inspector.markViewed': '標為已看 —— 順手收合',
  'inspector.unmarkViewed': '已看 —— 點一下取消',
  'inspector.resize': '拖曳調整寬度；← 加寬、→ 收窄',

  /* --------------------------- next action ----------------------------- */
  'next.commit': '還有未 commit 的變更 —— 現在合併不會包含它們',
  'next.rebase': '{branch} 已前進 {n} 個 commit —— 合併前先 rebase',
  'next.finish': '乾淨且領先 —— 可以合併回 {branch} 或開 PR',
  'inspector.runHint': '在這個 attempt 的 worktree 裡執行 `{name}`，開自己的終端機',
  'inspector.worktreeGroup': 'worktree',
  'inspector.shell': 'shell',
  'inspector.shellHint': '在這個 attempt 的 worktree 裡，你自己的 shell',
  'inspector.queued': '有一則訊息排在這輪結束後',
  'inspector.cancelQueued': '取消',
  'timeline.waited': '· 等了 {for}',

  /* ----------------------------- review ------------------------------- */
  'review.hint': '點一下，對這行附上意見',
  'review.placeholder': '這裡該怎麼改？',
  'review.add': '加入意見',
  'review.remove': '移除這則意見',
  'review.send': '把 {count} 則意見送回給 agent',
  'review.queue': '這輪結束後送出 {count} 則',
  'review.copy': '複製意見',
  'review.header': '[AgentDesk 檢視回饋] 以下是對目前 diff 的意見：',
  'review.footer': '請逐點修改，改完後 commit 在這個分支上。',

  /* ------------------------------ env --------------------------------- */
  'env.shell': 'shell',
  'env.source': '環境來源',
  'env.sourceLogin': 'login shell ✓',
  'env.sourceSystem': '系統環境 ✓',
  'env.sourceProcess': 'process env（降級）',
  'env.varCount': '變數數量',
  'env.claude': 'claude',
  'env.claudeMissing': '找不到',
  'env.db': '資料庫',
  'env.degraded':
    '無法從 login shell 取得環境，已退回本行程的環境。npx 型的 MCP server 可能起不來。',
  'env.language': '語言',
  'env.messaging': '跨 session 互傳訊息',
  'env.messagingOff': '需要 Claude Code ≥ 2.1.224（目前 {version}）',
  'env.profiles': 'Agent 設定檔',
  'env.profilesHint': '哪個 CLI，加上它每次都帶的參數。兩個啟動對話框都看得到。',
  'env.notifications': '通知',
  'notify.hint': '只在視窗不在前景時才發。',
  'notify.permission': '授權與資料夾信任',
  'notify.input': '等你回覆',
  'notify.done': '完成一輪',
  'notify.test': '送一則測試通知',
  'notify.sent': '已送出 ✓',

  /* ------------------- terminal screen reader mode --------------------- */
  'env.termSr': '終端機螢幕閱讀器模式',
  'termSr.hint':
    '每個終端機（含授權提示）都變得能被螢幕閱讀器讀到。代價：放棄 GPU 繪製，大量輸出時捲動會比較不順。',
  'termSr.toggle': '把終端機文字提供給螢幕閱讀器',

  /* --------------------------- checkpoints ----------------------------- */
  'env.checkpoints': '檢查點',
  'ckpt.hint':
    '每輪結束時快照一次 worktree。存在私有 ref 裡，attempt 結束即刪；agent 自己的 git 狀態一概不碰。',
  'ckpt.onStop': '回合結束時自動快照（Claude Code session）',
  'inspector.ckpt': '檢查點',
  'inspector.ckptHint': '現在就快照這個 worktree —— 任何 agent、任何時刻',
  'inspector.ckptMade': '已留存 #{n} ✓',
  'inspector.ckptNone': '距上一個檢查點沒有變更',
  'ckpt.restoreHint': '把 worktree 還原到此輪之前 —— 只還程式碼，對話不動',
  'ckpt.restoreArm': '確定還原到此輪之前？',
  'ckpt.blocked': 'agent 回合進行中；等回合結束（或關閉 session）才能還原',
  'ckpt.restored': '已還原到檢查點 #{n}。還原前的狀態已先快照。',
  'ckpt.restoredBase': '已還原到 attempt 起點（base）。還原前的狀態已先快照。',
  'ckpt.tell': '告訴 agent',
  'ckpt.note':
    '提醒：這個 worktree 已被還原到較早的檢查點。檔案內容可能與你上次寫入的不同 —— 編輯前請先重新讀取。',
  'board.park': '暫停',
  'board.parkHint': '把 worktree 與併發槽還回去 —— 分支、檢查點、對話都留著',
  'park.done': '已暫停。分支 {branch} 已在剪貼簿 —— 工作與對話都留著。',
  'park.restoreFailed':
    '已繼續，但暫停時的工作沒有完整回來：{err}。worktree 已在分支上 —— 可從時間軸還原。',
  'park.restoreParked': '已暫停 —— 先繼續，再還原',
  /* ---------------------------- preview ------------------------------ */
  'preview.title': 'Dev server 預覽',
  'preview.open': '預覽',
  'preview.openHint': '把 dev server 掛在桌邊看 —— 頁面就是 server 送出的樣子',
  'preview.sshHint':
    'server 在遠端機器上，埠從這裡打不到。自己開一條 tunnel，或在那台機器的瀏覽器看。',
  'preview.copy': '複製',
  'preview.reload': '重新載入頁面',
  'preview.external': '用瀏覽器開啟',
  'preview.dead': 'server 已結束 —— 它的終端機關了。',
  'preview.notListening': '{url} 目前沒有回應。',
  'preview.retry': '再試一次',
  'preview.close': '關閉預覽',
  'preview.pick': '{component} —— {file}:{line}',
  'preview.note':
    '我在預覽裡指著 {component}（{file}:{line}）—— 接下來的回饋是關於這個元件。',
  'ckpt.timelineHint': '每個 prompt 列都有 ↩ —— 可把程式碼還原到那一輪之前。',
  'inspector.diffKeys': 'j/k 走行 · n/p 走檔 · e 編輯 · v 已看 · Enter 留言',
  'ckpt.compare': '比較對象',
  'ckpt.compareBase': 'Base —— 整個 attempt',
  'ckpt.compareN': '檢查點 #{n} · {time}',
  /* -------------------------- editable diff --------------------------- */
  'edit.chip': '編輯',
  'edit.hint': '就地編輯這個檔 —— 存檔會寫進 attempt 的 worktree',
  'edit.oneAtATime': '一次編輯一個檔 —— 先存檔或關掉開著的編輯器',
  'edit.save': '存檔',
  'edit.saveHint': '把這份內容寫進 {file}（⌘S）',
  'edit.saved': '已存檔 ✓',
  'edit.close': '收合',
  'edit.note': '我手動改了 {file}，重讀後再繼續。',
  'edit.failed': '讀不到 {file}：{err}',
  'edit.discardTitle': '有未存的變更',
  'edit.discardBody': '關掉編輯器，放棄對 {file} 的修改？',
  'edit.discard': '放棄修改',
  'edit.keep': '繼續編輯',
  'edit.compareLocked': '關掉編輯器才能切換比較基準',
  'review.stale': '行已變',
  'review.staleHint': '引用的那行已不在 diff 裡 —— 訊息照送，引用的是你當時看到的。',
  /* ----------------------------- worlds ------------------------------- */
  'world.local': '本機',
  'world.where': '世界',
  'world.pick': '新卡片與新 session 開在哪 —— 包含 WSL distro 與 SSH host',
  'world.hint': '新開的東西預設在這裡。每張卡各自保有自己的世界。',
  'world.probing': '連線中…',
  'world.noClaude': '這個世界的 PATH 上找不到 claude',
  /* ------------------------ find in terminal -------------------------- */
  'term.find': '搜尋終端機',
  'term.findHint': 'Enter 找下一個、Shift+Enter 找上一個、Esc 關閉',
  'term.prev': '上一個符合',
  'term.next': '下一個符合',
  'term.noMatch': '沒有符合',
  'keys.find': '在聚焦的終端機裡搜尋（終端機內改用 Ctrl+Shift+F）',
  /* --------------------------- token account -------------------------- */
  'usage.line': '語境 {ctx} · 輸出 {out}',
  'usage.tip':
    '每回合結束時從 transcript 讀一次。語境 {context} 是上一輪請求的 prompt 大小。累計：輸入 {input}、輸出 {output}、快取寫入 {write}、快取讀取 {read}。',

  /* ----------------------------- profiles ------------------------------ */
  'profile.namePlaceholder': 'opus、安靜的 claude、…',
  'profile.add': '新增設定檔',
  'profile.remove': '移除這個設定檔',
  'profile.save': '儲存設定檔',
  'profile.saved': '已儲存 ✓',

  /* ------------------------------ views ------------------------------- */
  'view.overview': '總覽',
  'view.board': '看板',
  'view.noSession': '尚無 session',
  'view.inspector': '檢視器',
  'view.terminal': '終端機',

  /* ------------------------------ errors ------------------------------ */
  'error.updateTab': '更新分頁失敗：{err}',
  'error.openSession': '開啟 session 失敗：{err}',
  'error.reopen': '重新開啟失敗：{err}',
  'error.resumeAttempt': '繼續 attempt 失敗：{err}',
  'error.moveCard': '搬移卡片失敗：{err}',
  'error.cancelQueue': '取消排隊失敗：{err}',
  'error.park': '暫停失敗：{err}',
  'error.deleteCard': '刪除卡片失敗：{err}',
  'error.newTab': '新增分頁失敗：{err}',
  'error.runScript': '啟動 run script 失敗：{err}',
  'error.openShell': '開 worktree shell 失敗：{err}',
};

export type Locale = 'en' | 'zh-TW';

export const CATALOG: Record<Locale, Record<MessageKey, string>> = { en, 'zh-TW': zhTW };

export type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Substitutes `{name}` placeholders. An unknown key renders as itself, which
    is louder in a screenshot than an empty string and easier to grep for. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** A translator for one language, with no React attached — which is what lets
    the model tests exercise label logic directly. */
export function translator(locale: Locale): TFn {
  return (key, vars) => format(CATALOG[locale][key] ?? key, vars);
}
