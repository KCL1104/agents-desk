import { useState } from 'react';
import { needsYou, type SessionMeta, type Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeId: string | null;
  sessions: SessionMeta[];
  /** Tab to open directly in rename mode, if any. */
  renameId?: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
}

/**
 * The tab strip.
 *
 * Each tab carries a badge for the sessions it is showing. Without it a tab is
 * somewhere problems go to hide: you would sit in one arrangement while an
 * agent in another sat blocked, which is the opposite of what this app is for.
 */
export function TabStrip({
  tabs,
  activeId,
  sessions,
  renameId,
  onSelect,
  onCreate,
  onRename,
  onClose,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const active = editing ?? renameId ?? null;
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((t) => {
        const shown = t.slots
          .filter((id): id is string => id !== null)
          .map((id) => byId.get(id))
          .filter((s): s is SessionMeta => s !== undefined);
        const waiting = shown.filter((s) => needsYou(s.status)).length;
        const busy = shown.some((s) => s.status === 'running' || s.status === 'starting');

        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab${t.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => setEditing(t.id)}
            title={`${t.name} — 雙擊改名`}
            data-testid={`tab-${t.id}`}
          >
            {active === t.id ? (
              <input
                className="tab-rename"
                autoFocus
                defaultValue={t.name}
                onBlur={(e) => {
                  onRename(t.id, e.target.value.trim() || t.name);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="tab-name">{t.name}</span>
                {waiting > 0 ? (
                  <span className="tab-badge waiting" title="等你處理">
                    ⚠{waiting}
                  </span>
                ) : busy ? (
                  <span className="tab-badge busy" title="執行中">
                    ●
                  </span>
                ) : null}
                {tabs.length > 1 && (
                  <button
                    className="tab-close"
                    title="關閉分頁（session 會留在側邊欄）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(t.id);
                    }}
                  >
                    ✕
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
      <button className="tab-add" onClick={onCreate} title="新分頁">
        +
      </button>
    </div>
  );
}
