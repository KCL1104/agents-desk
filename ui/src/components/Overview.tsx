import { useEffect, useState } from 'react';
import type { SessionMeta } from '../types';
import { elapsed, SECTION_KEY, sectionOf, STATUS_KEY, type Section } from '../sections';
import { useT } from '../i18n';

interface Props {
  sessions: SessionMeta[];
  onOpen: (id: string) => void;
  onComplete: (id: string, completed: boolean) => void;
  onClose: (id: string) => void;
}

const ORDER: Section[] = ['working', 'waiting', 'done'];

/**
 * The oversight view: every session at once, as text.
 *
 * Deliberately not a wall of shrunken terminals. At the widths that fit six
 * panes on screen a TUI wraps into unreadable fragments, and the question you
 * are asking — what is each agent doing — is answered better by the tool call
 * it just made than by its redrawn frame.
 *
 * Sections are ordered the same way as the sidebar, so the two views of the
 * same data never disagree.
 */
export function Overview({ sessions, onOpen, onComplete, onClose }: Props) {
  const t = useT();
  // One timer for every elapsed counter on the page.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="overview empty">
        <p className="muted">{t('overview.empty')}</p>
      </div>
    );
  }

  const bySection = new Map<Section, SessionMeta[]>(ORDER.map((s) => [s, []]));
  for (const s of sessions) bySection.get(sectionOf(s))?.push(s);

  return (
    <div className="overview">
      {ORDER.map((section) => {
        const rows = bySection.get(section) ?? [];
        if (rows.length === 0) return null;
        return (
          <section className="ov-section" key={section} data-ov-section={section}>
            <h2 className="ov-section-head">
              {t(SECTION_KEY[section])}
              <span className="section-count">{rows.length}</span>
            </h2>
            <div className="ov-grid">
              {rows.map((s) => (
                <Card
                  key={s.id}
                  session={s}
                  now={now}
                  onOpen={onOpen}
                  onComplete={onComplete}
                  onClose={onClose}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({
  session: s,
  now,
  onOpen,
  onComplete,
  onClose,
}: {
  session: SessionMeta;
  now: number;
  onOpen: (id: string) => void;
  onComplete: (id: string, completed: boolean) => void;
  onClose: (id: string) => void;
}) {
  const t = useT();
  const since = elapsed(s.activity_since, now);

  return (
    <article
      className={`ov-card ${s.status}`}
      data-testid={`card-${s.id}`}
      // Same identity rules as the board: a labeled group whose title is a
      // real stretched button — one click (or Enter on it) walks through —
      // and the session wears its one name, the card title, not its
      // worktree directory.
      role="group"
      aria-label={`${s.title}，${t(STATUS_KEY[s.status])}`}
    >
      <header className="ov-card-head">
        <span className={`dot ${s.status}`} />
        <button className="card-door ov-title" title={s.cwd} onClick={() => onOpen(s.id)}>
          {s.title}
        </button>
        <span className="ov-agent mono">{s.agent}</span>
      </header>

      <div className="ov-status">{t(STATUS_KEY[s.status])}</div>

      {s.activity ? (
        <div className="ov-activity">
          <span className="row-tool mono">{s.activity.tool}</span>
          {s.activity.detail && <span className="ov-detail mono">{s.activity.detail}</span>}
        </div>
      ) : (
        <div className="ov-activity muted small">
          {s.reports_status ? t('overview.noAction') : t('overview.noStatus')}
        </div>
      )}

      <footer className="ov-card-foot">
        <span className="mono small muted" title={s.cwd}>
          {since || ''}
        </span>
        <span className="ov-actions">
          {/* Buttons inside the card must not also walk through it. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onComplete(s.id, !s.completed);
            }}
          >
            {s.completed ? t('overview.unmarkDone') : t('overview.markDone')}
          </button>
          {s.live && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
            >
              {t('common.close')}
            </button>
          )}
          {/* Primary only while there is a live terminal to look at. On a
              closed card, "reopen" is an option, not the thing 已完成 is for. */}
          <button
            className={s.live ? 'primary' : ''}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(s.id);
            }}
          >
            {t('common.open')}
          </button>
        </span>
      </footer>
    </article>
  );
}
