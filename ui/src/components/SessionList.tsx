import { useEffect, useState } from 'react';
import { needsYou, type SessionMeta } from '../types';
import { elapsed, SECTION_LABEL, useSections, type Section } from '../sections';
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

const STATUS_LABEL: Record<SessionMeta['status'], string> = {
  starting: '啟動中',
  running: '執行中',
  waiting_permission: '等你授權',
  waiting_input: '等你回覆',
  idle: '待命',
  saved: '已關閉',
  exited: '已結束',
};

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
        <button className="icon" onClick={onNew} title="新 session">
          +
        </button>
      </div>

      {waiting.length > 0 && (
        <button className="waiting-banner" onClick={() => onSelect(waiting[0].id)}>
          ⚠ {waiting.length} 個等你
        </button>
      )}

      <div className="session-groups">
        {sessions.length === 0 && <p className="muted pad small">還沒有 session</p>}

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
                <span>{SECTION_LABEL[section]}</span>
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
        環境
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
  const activity = s.activity;
  const since = elapsed(s.activity_since, now);

  return (
    <div
      className={`session-row${active ? ' active' : ''}`}
      onClick={() => onSelect(s.id)}
      data-testid={`session-${s.id}`}
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
        <span className="row-title">{basename(s.cwd)}</span>
        <span className="row-actions">
          <button
            className="row-action"
            title={s.completed ? '取消完成標記' : '標記為完成'}
            onClick={(e) => {
              e.stopPropagation();
              onComplete(s.id, !s.completed);
            }}
          >
            {s.completed ? '↩' : '✓'}
          </button>
          <button
            className="row-action"
            title={s.live ? '關閉終端機' : '從清單移除'}
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
          <span className="muted">{STATUS_LABEL[s.status]}</span>
        )}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
