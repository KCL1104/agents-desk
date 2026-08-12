import { useEffect, useState } from 'react';
import { needsYou, type SessionMeta } from '../types';
import { elapsed, SECTION_KEY, STATUS_KEY, useSections, type Section } from '../sections';
import { useT } from '../i18n';
import { DRAG_MIME, encodeDrag } from '../layout';
import { api } from '../api';
import { Icon } from './Icon';
import { WorldPicker } from './WorldPicker';

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
  onShowSettings: () => void;
}

/** Blocked rows first: with many agents, "who is waiting on me" is the
 *  only ordering that matters, and the top of the sidebar is the queue. */
const ORDER: Section[] = ['waiting', 'working', 'idle', 'done'];

export function SessionList({
  sessions,
  activeId,
  unseen,
  onSelect,
  onNew,
  onClose,
  onArchive,
  onComplete,
  onShowSettings,
}: Props) {
  const t = useT();
  const display = useSections(sessions, activeId);
  const waiting = sessions.filter((s) => needsYou(s.status));

  // 已完成 is where finished work goes to stop taking up attention, so it
  // starts collapsed.
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({
    waiting: false,
    working: false,
    idle: false,
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
          <Icon name="warn" />
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
                aria-expanded={!isCollapsed}
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

      {/* The corner: where new things open (the host), and how the app is
          set (settings). One block, so the two rows share a gutter, a seam
          and a hover — and so neither can be squeezed by a short window
          (.sidebar-corner is flex: none). */}
      <div className="sidebar-corner">
        <WorldPicker />
        <button className="sidebar-foot" onClick={onShowSettings}>
          {t('common.env')}
          <UpdateDot />
        </button>
      </div>
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
      aria-label={`${s.title}${t('common.sep')}${t(STATUS_KEY[s.status])}${unseen ? `${t('common.sep')}${t('unseen.label')}` : ''}`}
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
          {/* aria-label 與 title 同一句：字形（✓ ↩ ✕）不是可朗讀的名字。 */}
          <button
            className="row-action"
            aria-label={s.completed ? t('sidebar.unmarkDone') : t('sidebar.markDone')}
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
            aria-label={s.live ? t('sidebar.closeTerminal') : t('sidebar.removeFromList')}
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


/**
 * A dot on the settings button when a newer version exists.
 *
 * Everything about this is a decision not to interrupt. It is in the corner
 * rather than over the board, because the board is the triage loop and a
 * "there is an update!" panel landing on a card that just turned amber is
 * the worst thing this app could do with the news. It carries no number and
 * no animation — the tray's own rule, that a thing which always says its own
 * name spends a permanent slice of attention to tell you something you knew.
 * And it says nothing at all when there is nothing: no dot is the resting
 * state, not a state that had to be earned.
 *
 * The check behind it runs once per mount and only when the desk has already
 * decided it is due — once a day, off entirely if the switch is off, and
 * never at all on a build with no key or a copy a package manager owns.
 * A failure leaves the corner exactly as it was.
 */
function UpdateDot() {
  const t = useT();
  const [waiting, setWaiting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .updateStatus()
      .then((s) => {
        if (!alive) return;
        if (!s.configured || !s.selfContained || !s.enabled || !s.due) return;
        return api.updateCheck().then((found) => {
          if (alive && found) setWaiting(found.version);
        });
      })
      .catch(() => {
        /* offline, or a desk that has not booted: the corner stays quiet */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!waiting) return null;
  return (
    <span
      className="update-dot"
      data-testid="update-dot"
      // The dot is decoration; the sentence is the meaning, and it goes to
      // the button's own label so a screen reader reads "Settings, Marol
      // 0.7.0 available" as one thing rather than announcing a bullet.
      aria-label={t('up.newVersion', { version: waiting })}
      title={t('up.newVersion', { version: waiting })}
    />
  );
}
