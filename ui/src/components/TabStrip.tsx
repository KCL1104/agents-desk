import { useState } from 'react';
import { useT } from '../i18n';
import { needsYou, type SessionMeta, type Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeId: string | null;
  sessions: SessionMeta[];
  /** Sessions that finished while unwatched, for the badge's middle tier. */
  unseen: ReadonlySet<string>;
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
  unseen,
  renameId,
  onSelect,
  onCreate,
  onRename,
  onClose,
}: Props) {
  const tr = useT();
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
        const unread = shown.filter((s) => unseen.has(s.id)).length;
        const busy = shown.some((s) => s.status === 'running' || s.status === 'starting');

        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab${t.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
            onDoubleClick={() => setEditing(t.id)}
            title={tr('tabs.rename', { name: t.name })}
            data-testid={`tab-${t.id}`}
            // Roving tabindex: the strip is one tab stop, arrows move within
            // it, Enter or F2 renames — the whole contract role="tab" makes.
            tabIndex={t.id === activeId ? 0 : -1}
            onKeyDown={(e) => {
              // Only when the tab itself has focus — keys typed into the
              // rename input bubble through here and belong to it.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const i = tabs.findIndex((x) => x.id === t.id);
                const step = e.key === 'ArrowRight' ? 1 : -1;
                const next = tabs[(i + step + tabs.length) % tabs.length];
                onSelect(next.id);
                (
                  e.currentTarget.parentElement?.querySelector(
                    `[data-testid="tab-${next.id}"]`,
                  ) as HTMLElement | null
                )?.focus();
              } else if (e.key === 'Enter' || e.key === 'F2') {
                e.preventDefault();
                setEditing(t.id);
              }
            }}
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
                  if (e.key === 'Escape') {
                    // Put the old name back, then leave through blur — the
                    // one path that also clears an app-driven rename.
                    e.currentTarget.value = t.name;
                    e.currentTarget.blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="tab-name">{t.name}</span>
                {/* One badge, by urgency: blocked beats unread beats busy.
                    Unread wears a count in a filled pill — mail's unread
                    grammar — so it never reads as the busy dot. */}
                {waiting > 0 ? (
                  <span className="tab-badge waiting" title={tr('tabs.waiting')}>
                    ⚠{waiting}
                  </span>
                ) : unread > 0 ? (
                  <span className="tab-badge unseen" title={tr('tabs.unseen')}>
                    {unread}
                  </span>
                ) : busy ? (
                  <span className="tab-badge busy" title={tr('tabs.busy')}>
                    ●
                  </span>
                ) : null}
                {tabs.length > 1 && (
                  <button
                    className="tab-close"
                    title={tr('tabs.close')}
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
      <button className="tab-add" onClick={onCreate} title={tr('tabs.new')}>
        +
      </button>
    </div>
  );
}
