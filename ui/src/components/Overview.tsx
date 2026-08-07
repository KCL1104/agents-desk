import { useEffect, useState } from 'react';
import type { SessionMeta } from '../types';
import { elapsed, SECTION_LABEL, sectionOf, type Section } from '../sections';

interface Props {
  sessions: SessionMeta[];
  onOpen: (id: string) => void;
  onComplete: (id: string, completed: boolean) => void;
  onClose: (id: string) => void;
}

const ORDER: Section[] = ['working', 'waiting', 'done'];

const STATUS_LABEL: Record<SessionMeta['status'], string> = {
  starting: '啟動中',
  running: '執行中',
  waiting_permission: '等你授權',
  waiting_input: '等你回覆',
  idle: '待命',
  saved: '已關閉',
  exited: '已結束',
};

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
  // One timer for every elapsed counter on the page.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="overview empty">
        <p className="muted">還沒有 session。按左上角 + 開一個。</p>
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
              {SECTION_LABEL[section]}
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
  const since = elapsed(s.activity_since, now);

  return (
    <article
      className={`ov-card ${s.status}`}
      data-testid={`card-${s.id}`}
      onDoubleClick={() => onOpen(s.id)}
    >
      <header className="ov-card-head">
        <span className={`dot ${s.status}`} />
        <span className="ov-title">{basename(s.cwd)}</span>
        <span className="ov-agent mono">{s.agent}</span>
      </header>

      <div className="ov-status">{STATUS_LABEL[s.status]}</div>

      {s.activity ? (
        <div className="ov-activity">
          <span className="row-tool mono">{s.activity.tool}</span>
          {s.activity.detail && <span className="ov-detail mono">{s.activity.detail}</span>}
        </div>
      ) : (
        <div className="ov-activity muted small">
          {s.reports_status ? '沒有進行中的動作' : '這個 agent 不回報狀態'}
        </div>
      )}

      <footer className="ov-card-foot">
        <span className="mono small muted" title={s.cwd}>
          {since || ''}
        </span>
        <span className="ov-actions">
          <button onClick={() => onComplete(s.id, !s.completed)}>
            {s.completed ? '取消完成' : '完成'}
          </button>
          {s.live && <button onClick={() => onClose(s.id)}>關閉</button>}
          <button className="primary" onClick={() => onOpen(s.id)}>
            開啟
          </button>
        </span>
      </footer>
    </article>
  );
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
