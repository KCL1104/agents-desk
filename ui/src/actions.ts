import type { MessageKey } from './i18n';

/**
 * Every named thing the palette can do, in one table.
 *
 * The table is the point, more than any row in it: the palette, the ⌘/
 * cheat sheet, and whatever menus come later all render from here, so an
 * action's name, its chord, and its documentation cannot drift apart —
 * the same discipline `STATUS_KEY` holds for status names, applied to
 * verbs. Adding an action here makes it searchable and documented in the
 * same keystroke; the App supplies what each id actually does, because
 * running one needs the App's own state and this module needs none of it.
 */
export type ActionId =
  | 'jump-waiting'
  | 'new-card'
  | 'new-session'
  | 'toggle-inspector'
  | 'view-terminal'
  | 'view-board'
  | 'view-overview'
  | 'open-env'
  | 'open-keys'
  | 'show-welcome';

/** What an action's `when` may ask about. Kept to judgements the palette
 *  needs — this is visibility, not enablement: an action that cannot
 *  apply right now is simply not offered, never greyed. */
export interface ActionCtx {
  /** Any session currently blocked on a human. */
  hasWaiting: boolean;
  /** There is an attempt to inspect — a drawer up, or a focused pane
   *  that belongs to one. */
  canInspect: boolean;
}

export interface ActionDef {
  id: ActionId;
  title: MessageKey;
  /** The chord exactly as the cheat sheet prints it; null for actions
   *  that have buttons instead of keys. */
  keys: string | null;
  /** Absent means always offered. */
  when?: (ctx: ActionCtx) => boolean;
}

/** In the order the palette offers them: triage first, making second,
 *  navigation third, the app's own surfaces last. */
export const ACTIONS: readonly ActionDef[] = [
  { id: 'jump-waiting', title: 'keys.jump', keys: '⌘/Ctrl + E', when: (c) => c.hasWaiting },
  // Shift 生在和弦裡,所以終端機內外都是同一顆 —— shell 擁有的是
  // 無 Shift 的 Ctrl+字母。N 沒人用過;K 不行(終端機內 Ctrl+Shift+K
  // 已經是叫出面板的寫法),C 是複製,E/F/I 各有原主。
  { id: 'new-card', title: 'board.newCard', keys: '⌘/Ctrl + Shift + N' },
  { id: 'new-session', title: 'sidebar.newSession', keys: null },
  { id: 'toggle-inspector', title: 'keys.inspector', keys: '⌘/Ctrl + I', when: (c) => c.canInspect },
  { id: 'view-terminal', title: 'view.terminal', keys: '⌘/Ctrl + 1' },
  { id: 'view-board', title: 'view.board', keys: '⌘/Ctrl + 2' },
  { id: 'view-overview', title: 'view.overview', keys: '⌘/Ctrl + 3' },
  { id: 'open-env', title: 'common.env', keys: null },
  { id: 'open-keys', title: 'keys.title', keys: '⌘/Ctrl + /' },
  // 重看歡迎面板:偵測重跑、旗標不動 —— 給剛裝好 CLI 的人一條回門口的路。
  { id: 'show-welcome', title: 'welcome.reopen', keys: null },
];

/** Keyboard that is not an action — movement and editing chords the sheet
 *  documents but nobody would run from a palette. */
export const KEY_DOCS: readonly { combo: string; what: MessageKey }[] = [
  { combo: '⌘/Ctrl + K', what: 'keys.palette' },
  { combo: '⌘/Ctrl + F', what: 'keys.find' },
  { combo: '⌘/Ctrl + ⌥/Alt + ← · →', what: 'keys.cyclePanes' },
  { combo: '⌘/Ctrl + ← → · ↑ ↓', what: 'keys.moveCard' },
  { combo: 'Ctrl + PgDn · PgUp', what: 'keys.cycleTabs' },
  { combo: 'J · K', what: 'keys.diff' },
  { combo: 'Esc', what: 'keys.escape' },
];

/**
 * The pointer's side of the sheet. These lived only in tooltips, which the
 * sheet's own comment calls the way gestures go unfound — so the sheet
 * lists them beside the keys, one row per surface.
 */
export const GESTURES: readonly { where: MessageKey; what: MessageKey }[] = [
  { where: 'gesture.pane', what: 'pane.dragHint' },
  { where: 'gesture.tab', what: 'gesture.tabWhat' },
  { where: 'gesture.splitter', what: 'splitter.hint' },
  { where: 'gesture.row', what: 'gesture.rowWhat' },
];
