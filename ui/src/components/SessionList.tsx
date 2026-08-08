import { useEffect, useState } from 'react';
import { needsYou, type SessionMeta } from '../types';
import { elapsed, SECTION_KEY, STATUS_KEY, useSections, type Section } from '../sections';
import { useT } from '../i18n';
import { DRAG_MIME, encodeDrag } from '../layout';

interface Props {
  sessions: SessionMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onArchive: (id: string) => void;
  onComplete: (id: string, completed: boolean) => void;
  onShowEnv: () => void;
}

const ORDER: Section[] = ['working', 'waiting', 'done'];

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onClose,
  onArchive,
  onComplete,
  onShowEnv,
}: Props) {
  const t = useT();
  const display = useSections(sessions, activeId);
  const waiting = sessions.filter((s) => needsYou(s.status));

  // 已完成 is where finished work goes to stop taking up attention, so it
  // starts collapsed.
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({
    working: false,
    waiting: false,
    done: true,
  });

  // One timer drives every elapsed counter, rather than one per row.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const bySection = new Map<Section, SessionMeta[]>(ORDER.map((s) => [s, []]));
  for (const s of sessions) {
    bySection.get(display[s.id] ?? 'working')?.push(s);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>SESSIONS</span>
        <button className="icon" onClick={onNew} title={t('sidebar.newSession')}>
          +
        </button>
      </div>

      {waiting.length > 0 && (
        <button className="waiting-banner" onClick={() => onSelect(waiting[0].id)}>
          {t('sidebar.waitingCount', { count: waiting.length })}
        </button>
      )}

      <div className="session-groups">
        {sessions.length === 0 && <p className="muted pad small">{t('sidebar.empty')}</p>}

        {ORDER.map((section) => {
          const rows = bySection.get(section) ?? [];
          if (rows.length === 0) return null;
          const isCollapsed = collapsed[section];
          return (
            <div className="section" key={section} data-section={section}>
              <button
                className="section-head"
                onClick={() => setCollapsed((c) => ({ ...c, [section]: !c[section] }))}
              >
                <span className="section-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span>{t(SECTION_KEY[section])}</span>
                <span className="section-count">{rows.length}</span>
              </button>

              {!isCollapsed &&
                rows.map((s) => (
                  <Row
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    now={now}
                    onSelect={onSelect}
                    onClose={onClose}
                    onArchive={onArchive}
                    onComplete={onComplete}
                  />
                ))}
            </div>
          );
        })}
      </div>

      <button className="sidebar-foot" onClick={onShowEnv}>
        {t('common.env')}
      </button>
    </aside>
  );
}

function Row({
  session: s,
  active,
  now,
  onSelect,
  onClose,
  onArchive,
  onComplete,
}: {
  session: SessionMeta;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onArchive: (id: string) => void;
  onComplete: (id: string, completed: boolean) => void;
}) {
  const t = useT();
  const activity = s.activity;
  const since = elapsed(s.activity_since, now);

  return (
    <div
      className={`session-row${active ? ' active' : ''}`}
      onClick={() => onSelect(s.id)}
      data-testid={`session-${s.id}`}
      // A div wearing button semantics, because a real <button> cannot hold
      // the inner action buttons — but it owes the keyboard everything a
      // button gives: focus, Enter, Space. The label carries the status so
      // AT hears which row is the one waiting, and keeps the inner ✓/✕
      // glyphs out of the computed name.
      role="button"
      tabIndex={0}
      aria-label={`${s.title}，${t(STATUS_KEY[s.status])}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(s.id);
        }
      }}
      // Dragging a row into the grid is the direct way to say which sessions
      // the layout should hold.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, encodeDrag({ kind: 'session', id: s.id }));
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="row-top">
        <span className={`dot ${s.status}`} />
        {/* The session's own name — for an attempt that is the card's title,
            which is what a person scans for. The directory is a hover away. */}
        <span className="row-title" title={s.cwd}>
          {s.title}
        </span>
        <span className="row-actions">
          <button
            className="row-action"
            title={s.completed ? t('sidebar.unmarkDone') : t('sidebar.markDone')}
            onClick={(e) => {
              e.stopPropagation();
              onComplete(s.id, !s.completed);
            }}
          >
            {s.completed ? '↩' : '✓'}
          </button>
          <button
            className="row-action"
            title={s.live ? t('sidebar.closeTerminal') : t('sidebar.removeFromList')}
            onClick={(e) => {
              e.stopPropagation();
              if (s.live) onClose(s.id);
              else onArchive(s.id);
            }}
          >
            ✕
          </button>
        </span>
      </div>

      <div className="row-sub mono">
        {activity ? (
          <>
            <span className="row-tool">{activity.tool}</span>
            {activity.detail && <span className="row-detail">{activity.detail}</span>}
            {since && <span className="row-elapsed">{since}</span>}
          </>
        ) : (
          <span className="muted">{t(STATUS_KEY[s.status])}</span>
        )}
      </div>
    </div>
  );
}

