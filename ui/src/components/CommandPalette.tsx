import { useMemo, useState } from 'react';
import type * as React from 'react';
import { useT, type TFn } from '../i18n';
import { needsYou, type SessionMeta, type Task } from '../types';
import { liveStateOf, repoName } from '../board';
import { STATUS_KEY } from '../sections';
import { ACTIONS, type ActionCtx, type ActionDef, type ActionId } from '../actions';

interface Props {
  sessions: SessionMeta[];
  tasks: Task[];
  unseen: ReadonlySet<string>;
  ctx: ActionCtx;
  /** Go look at this session — closes the palette without restoring focus,
   *  because the terminal is exactly where focus is meant to land. */
  onOpenSession: (id: string) => void;
  /** A card with no live session has no terminal to land in; the board is
   *  where its buttons are — 帶著卡片 id 走,焦點才有落點,而不是把人
   *  丟在看板上、焦點留在 <body>。 */
  onOpenBoard: (taskId: string) => void;
  onRun: (id: ActionId) => void;
  onCancel: () => void;
}

/** One row the list can hold, whatever group it came from. */
type Item =
  | { kind: 'session'; session: SessionMeta }
  | { kind: 'task'; task: Task }
  | { kind: 'action'; def: ActionDef };

interface Group {
  label: string;
  items: Item[];
}

/**
 * ⌘/Ctrl+K: one keystroke that answers both "what needs me" and "take me
 * to X".
 *
 * The first group is not search results — it is the attention inbox:
 * blocked sessions, then turns that finished unwatched, standing there
 * before a letter is typed, so the reflex under interruption is ⌘K,
 * Enter. Navigation across every session and card appears once there is
 * a query to match; the action rows come from the same registry the
 * cheat sheet prints.
 *
 * Deliberately not a fuzzy matcher: at a desk's scale (tens of rows, not
 * thousands) substring-on-what-you-see is predictable, and predictable
 * beats clever in the muscle-memory path.
 */
export function CommandPalette({
  sessions,
  tasks,
  unseen,
  ctx,
  onOpenSession,
  onOpenBoard,
  onRun,
  onCancel,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const groups = useMemo(
    () => buildGroups(query, sessions, tasks, unseen, ctx, t),
    [query, sessions, tasks, unseen, ctx, t],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const sel = Math.min(selected, Math.max(0, flat.length - 1));

  const run = (item: Item) => {
    if (item.kind === 'session') {
      onOpenSession(item.session.id);
    } else if (item.kind === 'task') {
      // The card's own door rule: a live session behind it is the
      // destination; otherwise the board is where its buttons are.
      const live = liveStateOf(item.task, sessions);
      if (live.kind === 'session') onOpenSession(live.session.id);
      else onOpenBoard(item.task.id);
    } else {
      onRun(item.def.id);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((sel + step + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[sel]) run(flat[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Stopped here so the document-level listeners never also see it —
      // one Esc closes one surface.
      e.stopPropagation();
      onCancel();
    }
  };

  // The flat index each rendered row carries, for selection and ARIA.
  let at = -1;

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onCancel}>
      <div
        className="palette"
        role="dialog"
        aria-label={t('keys.palette')}
        data-testid="palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          placeholder={t('palette.placeholder')}
          data-testid="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={flat.length > 0 ? `palette-item-${sel}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list" id="palette-list" role="listbox">
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <div className="palette-group-head" aria-hidden="true">
                {g.label}
              </div>
              {g.items.map((item) => {
                at += 1;
                const i = at;
                return (
                  <div
                    key={itemKey(item)}
                    id={`palette-item-${i}`}
                    className={`palette-item${i === sel ? ' selected' : ''}`}
                    role="option"
                    aria-selected={i === sel}
                    data-testid={itemKey(item)}
                    // Mouse follows the same selection the keyboard walks,
                    // so there is never a second highlight to reason about.
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(item)}
                  >
                    <ItemRow item={item} t={t} />
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <p className="palette-empty">{t('palette.empty')}</p>}
        </div>
      </div>
    </div>
  );
}

function itemKey(item: Item): string {
  switch (item.kind) {
    case 'session':
      return `pal-session-${item.session.id}`;
    case 'task':
      return `pal-task-${item.task.id}`;
    case 'action':
      return `pal-action-${item.def.id}`;
  }
}

function ItemRow({ item, t }: { item: Item; t: TFn }) {
  if (item.kind === 'session') {
    const s = item.session;
    return (
      <>
        <span className={`dot ${s.status}`} />
        <span className="palette-title">{s.title}</span>
        <span className="palette-sub">{t(STATUS_KEY[s.status])}</span>
      </>
    );
  }
  if (item.kind === 'task') {
    return (
      <>
        <span className="palette-title">{item.task.title}</span>
        <span className="palette-sub mono">{repoName(item.task.repo_path)}</span>
      </>
    );
  }
  return (
    <>
      <span className="palette-title">{t(item.def.title)}</span>
      {item.def.keys && (
        <span className="palette-sub">
          <kbd>{item.def.keys}</kbd>
        </span>
      )}
    </>
  );
}

/**
 * What the list holds for a given query. Attention groups stand before a
 * letter is typed; every session and card joins once there is something
 * to match; a row never appears twice, whichever group claimed it first.
 */
function buildGroups(
  query: string,
  sessions: SessionMeta[],
  tasks: Task[],
  unseen: ReadonlySet<string>,
  ctx: ActionCtx,
  t: TFn,
): Group[] {
  const q = query.trim().toLowerCase();
  const hits = (text: string) => q === '' || text.toLowerCase().includes(q);

  const groups: Group[] = [];
  const claimed = new Set<string>();

  const waiting = sessions.filter((s) => needsYou(s.status) && hits(s.title));
  if (waiting.length > 0) {
    waiting.forEach((s) => claimed.add(s.id));
    groups.push({
      label: t('palette.waiting'),
      items: waiting.map((session) => ({ kind: 'session', session })),
    });
  }

  const unread = sessions.filter(
    (s) => unseen.has(s.id) && !claimed.has(s.id) && hits(s.title),
  );
  if (unread.length > 0) {
    unread.forEach((s) => claimed.add(s.id));
    groups.push({
      label: t('palette.unseen'),
      items: unread.map((session) => ({ kind: 'session', session })),
    });
  }

  // Navigation earns its place by being asked for: with no query the
  // palette is an inbox, not a directory — the sidebar already is one.
  if (q !== '') {
    const rest = sessions.filter((s) => !claimed.has(s.id) && hits(s.title));
    if (rest.length > 0) {
      groups.push({
        label: t('palette.sessions'),
        items: rest.map((session) => ({ kind: 'session', session })),
      });
    }
    const cards = tasks.filter((task) => hits(task.title) || hits(repoName(task.repo_path)));
    if (cards.length > 0) {
      groups.push({
        label: t('palette.cards'),
        items: cards.map((task) => ({ kind: 'task', task })),
      });
    }
  }

  const actions = ACTIONS.filter((a) => (a.when?.(ctx) ?? true) && hits(t(a.title)));
  if (actions.length > 0) {
    groups.push({
      label: t('palette.actions'),
      items: actions.map((def) => ({ kind: 'action', def })),
    });
  }

  return groups;
}
