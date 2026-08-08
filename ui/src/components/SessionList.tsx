import { useEffect, useState } from 'react';
import { needsYou, type SessionMeta } from '../types';
import { elapsed, SECTION_KEY, STATUS_KEY, useSections, type Section } from '../sections';
import { useT } from '../i18n';
import { DRAG_MIME, encodeDrag } from '../layout';

interface Props {
  sessions: SessionMeta[];
  activeId: string | null;
  /** Sessions that finished a turn while their terminal was not in front
      of you. The row wears it like unread mail: weight plus a dot. */
  unseen: ReadonlySet<string>;
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
  unseen,
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
        <span>{t('sidebar.title')}</span>
        <button className="icon" onClick={onNew} title={t('sidebar.newSession')}>
          +
        </button>
      </div>

      {waiting.length > 0 && (
        <button
          className="waiting-banner"
          // Cycles like ⌘E: with three blocked agents each click lands on
          // the next one, instead of revisiting the first forever while the
          // keyboard path moves on. Same affordance, same behaviour.
          onClick={() => {
            const i = waiting.findIndex((s) => s.id === activeId);
            onSelect(waiting[(i + 1) % waiting.length].id);
          }}
        >
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
                    unseen={unseen.has(s.id)}
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
  unseen,
  now,
  onSelect,
  onClose,
  onArchive,
  onComplete,
}: {
  session: SessionMeta;
  active: boolean;
  unseen: boolean;
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
      className={`session-row${active ? ' active' : ''}${unseen ? ' unseen' : ''}`}
      data-testid={`session-${s.id}`}
      // A group holding one real door and its side actions — not a button
      // pretending to contain buttons, which is the one shape ARIA forbids.
      // The label carries the status so AT hears which row is waiting.
      role="group"
      aria-label={`${s.title}，${t(STATUS_KEY[s.status])}${unseen ? `，${t('unseen.label')}` : ''}`}
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
        {/* The door: a real button stretched over the whole row, so a click
            anywhere enters and the keyboard gets one honest tab stop. The
            title is what a person scans for; the directory is a hover away. */}
        <button className="row-door row-title" title={s.cwd} onClick={() => onSelect(s.id)}>
          {s.title}
        </button>
        {/* Finished behind your back — unread until its terminal has been
            in front of you. The label rides the aria-label above. */}
        {unseen && (
          <span className="unseen-dot" data-testid={`unseen-${s.id}`} title={t('unseen.label')} />
        )}
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

