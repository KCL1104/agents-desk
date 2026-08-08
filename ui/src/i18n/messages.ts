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

  /* ------------------------------ boot -------------------------------- */
  'boot.node': 'Node 20+ on your login shell PATH',
  'boot.sidecar': 'The sidecar built first:',
  'boot.claude': 'Claude Code CLI installed and signed in',
  'boot.retry': 'Retry',
  'boot.resolving': 'Resolving the login shell environment…',

  /* -------------------------- new session ----------------------------- */
  'newSession.title': 'New session',
  'newSession.cwd': 'Working directory',
  'newSession.cwdHint':
    'The same as {cd} into this directory and starting the agent there — the CLAUDE.md, .claude/ skills and .mcp.json it loads are exactly what you get in a terminal.',
  'newSession.args': 'Launch arguments (optional)',
  'newSession.argsHint': 'Passed to the CLI untouched, exactly as you would type them yourself.',
  'newSession.submit': 'Open terminal',

  /* ---------------------------- new card ------------------------------ */
  'newTask.title': 'New card',
  'newTask.titleLabel': 'Title',
  'newTask.titlePlaceholder': 'Fix the blank login page on Safari',
  'newTask.promptLabel': 'What the agent should do',
  'newTask.promptPlaceholder':
    'The screen goes white after signing in, with no console errors. Reproduce it first, then fix it.',
  'newTask.promptHint':
    'No need to mention CLAUDE.md, skills or MCP — the worktree loads them natively. Starting an attempt appends the branch and base, and you can edit it before it is sent.',
  'newTask.repo': 'Repo',
  'newTask.repoHint':
    'A local path — or wsl://<distro>/<path> for a repository inside WSL, or ssh://<host>/<path> for one on a machine in your ~/.ssh/config. The agent, git and worktrees all run where the repository lives.',
  'newTask.base': 'Base branch',
  'newTask.baseHint':
    'Every attempt opens a worktree and a branch from here, and diffs against it.',

  /* -------------------------- start attempt --------------------------- */
  'attempt.startTitle': 'Start attempt — {title}',
  'attempt.agent': 'Agent',
  'attempt.firstPrompt': 'First prompt',
  'attempt.trustHint':
    'Sending opens a fresh worktree — Claude Code will ask whether you trust the folder first, and the card lights up with “⚠ waiting on folder trust”. The prompt goes out once you have answered.',
  'attempt.unmeasuredHint':
    'We have not measured {agent}’s argument conventions, so nothing is sent automatically — a flag that means “here is your prompt” in one CLI can mean “print this and exit” in another. The session still opens; copy the text below into it.',
  'attempt.copied': 'Copied',
  'attempt.copyPrompt': 'Copy prompt',
  'attempt.openNoPrompt': 'Open session (no prompt)',
  'attempt.yoloHint':
    'No permission prompts at all — the agent runs to the end of its own judgement. The risk stays inside this card: an attempt only ever touches its own worktree and branch, never your checkout.',

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

  /* --------------------------- shortcuts ------------------------------ */
  'keys.title': 'Keyboard shortcuts',
  'keys.jump': 'Jump to the session waiting on you',
  'keys.views': 'Terminal wall · board · overview',
  'keys.cyclePanes': 'Focus the next / previous pane',
  'keys.cycleTabs': 'Next / previous tab',
  'keys.inspector': 'Open or close the inspector',
  'keys.diff': 'Walk the diff lines; Enter comments on one',
  'keys.escape': 'Close the open dialog',
  'keys.sheet': 'This list',
  'keys.shellNote':
    'Typing in a terminal? Ctrl+letter belongs to the shell there — add Shift (Ctrl+Shift+E), the same way Ctrl+Shift+C copies.',
  'splitter.hint': 'Drag to resize; double-click to reset to equal',

  /* ------------------------------ tabs -------------------------------- */
  'tabs.rename': '{name} — double-click to rename',
  'tabs.waiting': 'Waiting on you',
  'tabs.busy': 'Running',
  'tabs.close': 'Close tab (sessions stay in the sidebar)',
  'tabs.new': 'New tab',
  'tabs.defaultName': 'Workspace {n}',

  /* --------------------------- column picker -------------------------- */
  'cols.label': 'Columns',
  'cols.auto': 'Auto',
  'cols.n': '{n} col',
  'cols.custom': 'Custom',
  'cols.manualHint':
    'This tab’s layout is one you arranged; choosing anything else reverts it to automatic',
  'cols.autoHint': 'Choose the column count from the window width',

  /* ------------------------------ board ------------------------------- */
  'board.newCard': 'New card',
  'board.emptyBacklog': 'Press ＋ to add a card',
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

  /* ----------------------------- sections ----------------------------- */
  'section.working': 'Working',
  'section.waiting': 'Waiting on you',
  'section.done': 'Done',

  /* ---------------------------- inspector ----------------------------- */
  'inspector.changes': 'Changes',
  'inspector.activity': 'Activity',
  'inspector.reload': 'Reload',
  'inspector.closeView': 'Close inspector',
  'inspector.frozen': 'Frozen',
  'inspector.mergeInto': 'Merge into {branch}',
  'inspector.merged': 'Merged into {branch}',
  'inspector.openPr': 'Push + open PR',
  'inspector.discard': 'Discard',
  'inspector.discardHint':
    'Close this attempt and take the worktree back. Changes are frozen and kept.',
  'inspector.noChanges': 'This attempt has not changed any files yet.',
  'inspector.noActivity': 'No activity yet. Status reporting only works with Claude Code.',
  'inspector.runHint': 'Run `{name}` in this attempt’s worktree, in its own terminal',

  /* ----------------------------- review ------------------------------- */
  'review.hint': 'Click to attach feedback to this line',
  'review.placeholder': 'What should change here?',
  'review.add': 'Add feedback',
  'review.remove': 'Remove this feedback',
  'review.send': 'Send {count} back to the agent',
  'review.copy': 'Copy feedback',
  'review.header': '[AgentDesk review] Feedback on the current diff:',
  'review.footer': 'Please address each point above, then commit on this branch.',

  /* ------------------------------ env --------------------------------- */
  'env.shell': 'shell',
  'env.source': 'environment source',
  'env.sourceLogin': 'login shell ✓',
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
  'env.profilesHint':
    'A named way to launch an agent — the CLI plus the flags it always gets. Profiles appear in both launch dialogs.',

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
  'view.inspector': 'Changes / activity',
  'view.terminal': 'Terminal',

  /* ------------------------------ errors ------------------------------ */
  'error.updateTab': 'Could not update the tab: {err}',
  'error.openSession': 'Could not open the session: {err}',
  'error.reopen': 'Could not reopen: {err}',
  'error.resumeAttempt': 'Could not resume the attempt: {err}',
  'error.moveCard': 'Could not move the card: {err}',
  'error.cancelQueue': 'Could not leave the queue: {err}',
  'error.deleteCard': 'Could not delete the card: {err}',
  'error.newTab': 'Could not add the tab: {err}',
  'error.runScript': 'Could not start the run script: {err}',
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

  /* ------------------------------ boot -------------------------------- */
  'boot.node': 'Node 20+ 必須在你的 login shell PATH 上',
  'boot.sidecar': 'sidecar 要先建置：',
  'boot.claude': 'Claude Code CLI 必須已安裝並登入',
  'boot.retry': '重試',
  'boot.resolving': '正在解析 login shell 環境…',

  /* -------------------------- new session ----------------------------- */
  'newSession.title': '新 session',
  'newSession.cwd': '工作目錄',
  'newSession.cwdHint':
    '等同於 {cd} 到這裡再開 agent —— 載入的 CLAUDE.md、.claude/ skills 與 .mcp.json 跟你在終端機做完全一樣。',
  'newSession.args': '啟動參數（可留空）',
  'newSession.argsHint': '原封不動傳給 CLI，跟你自己在終端機打的一樣。',
  'newSession.submit': '開啟終端機',

  /* ---------------------------- new card ------------------------------ */
  'newTask.title': '新卡片',
  'newTask.titleLabel': '標題',
  'newTask.titlePlaceholder': '修好登入頁在 Safari 的白畫面',
  'newTask.promptLabel': '要 agent 做什麼',
  'newTask.promptPlaceholder': '登入後畫面全白，console 沒有錯誤。先重現再修。',
  'newTask.promptHint':
    '不用寫 CLAUDE.md、skills 或 MCP 的事 —— worktree 裡會原生載入。開 attempt 時會補上分支與 base 的說明，而且送出前可以改。',
  'newTask.repo': 'Repo',
  'newTask.repoHint':
    '本機路徑；或 wsl://<distro>/<路徑> 指向 WSL 裡的 repo；或 ssh://<host>/<路徑> 指向 ~/.ssh/config 裡那台機器上的 repo。agent、git、worktree 全部在 repo 所在的地方執行。',
  'newTask.base': 'Base 分支',
  'newTask.baseHint': '每個 attempt 從這裡開一個 worktree 與分支，diff 也以這裡為基準。',

  /* -------------------------- start attempt --------------------------- */
  'attempt.startTitle': '開始 attempt — {title}',
  'attempt.agent': 'Agent',
  'attempt.firstPrompt': '首則 prompt',
  'attempt.trustHint':
    '送出後會開一個新的 worktree —— Claude Code 會先問你信不信任這個資料夾，卡片會亮起「⚠ 等你確認資料夾」。答完之後這則 prompt 就會送出。',
  'attempt.unmeasuredHint':
    '{agent} 的參數慣例我們沒有實測過，所以不會自動送出 —— 在某個 CLI 代表「這是你的 prompt」的參數，在另一個可能代表「印出來然後結束」。session 照樣會開，把下面這段複製貼進去即可。',
  'attempt.copied': '已複製',
  'attempt.copyPrompt': '複製 prompt',
  'attempt.openNoPrompt': '開 session（不送 prompt）',
  'attempt.yoloHint':
    '完全不再詢問權限 —— agent 全憑自己的判斷跑到底。風險被關在這張卡裡：attempt 只碰得到自己的 worktree 與分支，碰不到你的 checkout。',

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

  /* --------------------------- shortcuts ------------------------------ */
  'keys.title': '鍵盤快捷鍵',
  'keys.jump': '跳到正在等你的 session',
  'keys.views': '終端機牆 · 看板 · 總覽',
  'keys.cyclePanes': '聚焦下一個 / 上一個 pane',
  'keys.cycleTabs': '下一個 / 上一個分頁',
  'keys.inspector': '開關檢視器',
  'keys.diff': '在 diff 行之間移動；Enter 對該行留言',
  'keys.escape': '關閉打開的對話框',
  'keys.sheet': '這份清單',
  'keys.shellNote':
    '正在終端機裡打字？Ctrl+字母屬於 shell —— 加上 Shift（Ctrl+Shift+E），就像 Ctrl+Shift+C 是複製一樣。',
  'splitter.hint': '拖曳調整比例；雙擊還原等分',

  /* ------------------------------ tabs -------------------------------- */
  'tabs.rename': '{name} — 雙擊改名',
  'tabs.waiting': '等你處理',
  'tabs.busy': '執行中',
  'tabs.close': '關閉分頁（session 會留在側邊欄）',
  'tabs.new': '新分頁',
  'tabs.defaultName': '工作 {n}',

  /* --------------------------- column picker -------------------------- */
  'cols.label': '欄數',
  'cols.auto': '自動',
  'cols.n': '{n} 欄',
  'cols.custom': '自訂',
  'cols.manualHint': '這個分頁的佈局是你自己排的；選其他值會還原成自動',
  'cols.autoHint': '依視窗寬度自動決定欄數',

  /* ------------------------------ board ------------------------------- */
  'board.newCard': '新增卡片',
  'board.emptyBacklog': '按 ＋ 新增卡片',
  'board.emptyDrop': '把卡片拖到這裡',
  'board.adHoc': '臨時 session',
  'board.adHocEmpty': '沒有臨時 session。',
  'board.concurrency': '同時執行',
  'board.less': '減少同時執行數',
  'board.more': '增加同時執行數',
  'board.queued': '· {count} 個排隊中',
  'board.start': '開始',
  'board.cancelQueue': '取消排隊',
  'board.resume': '繼續',
  'board.inspect': '檢視',
  'board.retry': '再試一次',
  'board.switchAgent': '換 agent',
  'board.retryHint': '用另一個 agent 再開一個 attempt',
  'board.deleteCard': '刪除卡片',
  'board.confirmDelete': '確定刪除？',

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

  /* ----------------------------- sections ----------------------------- */
  'section.working': '開發中',
  'section.waiting': '等待輸入',
  'section.done': '已完成',

  /* ---------------------------- inspector ----------------------------- */
  'inspector.changes': '變更',
  'inspector.activity': '活動',
  'inspector.reload': '重新讀取',
  'inspector.closeView': '關閉檢視',
  'inspector.frozen': '已凍結',
  'inspector.mergeInto': '合併回 {branch}',
  'inspector.merged': '已合併回 {branch}',
  'inspector.openPr': 'push + 開 PR',
  'inspector.discard': '丟棄',
  'inspector.discardHint': '關掉這個 attempt 並收回 worktree。變更會凍結保留。',
  'inspector.noChanges': '這個 attempt 還沒有改動任何檔案。',
  'inspector.noActivity': '還沒有活動。狀態回報只對 Claude Code 有效。',
  'inspector.runHint': '在這個 attempt 的 worktree 裡執行 `{name}`，開自己的終端機',

  /* ----------------------------- review ------------------------------- */
  'review.hint': '點一下，對這行附上意見',
  'review.placeholder': '這裡該怎麼改？',
  'review.add': '加入意見',
  'review.remove': '移除這則意見',
  'review.send': '把 {count} 則意見送回給 agent',
  'review.copy': '複製意見',
  'review.header': '[AgentDesk 檢視回饋] 以下是對目前 diff 的意見：',
  'review.footer': '請逐點修改，改完後 commit 在這個分支上。',

  /* ------------------------------ env --------------------------------- */
  'env.shell': 'shell',
  'env.source': '環境來源',
  'env.sourceLogin': 'login shell ✓',
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
  'env.profilesHint':
    '具名的啟動方式 —— 哪個 CLI、加上它每次都帶的參數。設定檔會出現在兩個啟動對話框裡。',

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
  'view.inspector': '變更／活動',
  'view.terminal': '終端機',

  /* ------------------------------ errors ------------------------------ */
  'error.updateTab': '更新分頁失敗：{err}',
  'error.openSession': '開啟 session 失敗：{err}',
  'error.reopen': '重新開啟失敗：{err}',
  'error.resumeAttempt': '繼續 attempt 失敗：{err}',
  'error.moveCard': '搬移卡片失敗：{err}',
  'error.cancelQueue': '取消排隊失敗：{err}',
  'error.deleteCard': '刪除卡片失敗：{err}',
  'error.newTab': '新增分頁失敗：{err}',
  'error.runScript': '啟動 run script 失敗：{err}',
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
