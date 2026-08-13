import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { worldLabel } from '../worlds';
import type { DirListing, World } from '../types';
import { Modal } from './Modal';

/**
 * Choosing a directory inside a world.
 *
 * Not the platform's folder dialog, and the reason is that the dialog cannot
 * answer the question for two of the three worlds. It browses the machine the
 * app runs on: for a WSL card that is the Windows side, reachable only by
 * navigating to `\\wsl$\<distro>` through Explorer's own idea of a
 * filesystem — and for an SSH host there is nothing to browse at all, because
 * nothing is mounted. VS Code has the same constraint and draws its own
 * picker for the same reason; this is that, in this app's shape.
 *
 * So: one list, filled by asking the world, identical for all three. What it
 * costs is the platform's file-manager affordances — creating a folder,
 * favourites, thumbnails — none of which belong in "which checkout is this
 * card about".
 *
 * Typing is the fast path and stays first-class: the input takes a whole path
 * and Enter goes there, so anybody who knows where they are going never
 * touches the list.
 */
export function DirPicker({
  world,
  start,
  onPick,
  onCancel,
}: {
  world: World;
  /** Where to open. Empty starts at the world's own home. */
  start?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(start ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which row the keyboard is on. -1 is the input, above the list. */
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Go somewhere. `null` means "the world's home", which is what an empty
   * box asks for.
   *
   * A failed step leaves the listing where it was rather than blanking it:
   * a typo in the box should not cost somebody the directory they had
   * already navigated to.
   */
  const go = (path: string | null) => {
    setBusy(true);
    setError(null);
    void api
      .listDir(world, path)
      .then((l) => {
        setListing(l);
        setTyped(l.path);
        setCursor(-1);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    go(start?.trim() ? start : null);
    // Once, on open. Re-running on `start` would fight the navigation.
  }, []);

  /** Join a child onto the current path, the way that world spells paths. */
  const child = (name: string) => {
    const base = listing?.path ?? '';
    const sep = base.includes('\\') && !base.startsWith('/') ? '\\' : '/';
    return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
  };

  /** `..` first, then the directories — one array so the cursor is one index. */
  const rows: { name: string; path: string; up?: boolean }[] = [
    ...(listing?.parent ? [{ name: '..', path: listing.parent, up: true }] : []),
    ...(listing?.dirs ?? []).map((d) => ({ name: d, path: child(d) })),
  ];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(-1, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // On a row, Enter descends. In the box, Enter goes to what was typed —
      // which for a path that is already the target is also how you accept
      // it, one keystroke from anywhere.
      if (cursor >= 0 && rows[cursor]) go(rows[cursor].path);
      else if (typed.trim() !== listing?.path) go(typed);
      else onPick(listing.path);
    }
  };

  // Keep the cursor row on screen when the keyboard walks past the fold.
  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.querySelectorAll('.dirpick-row')[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <Modal onCancel={onCancel} onSubmit={() => listing && onPick(listing.path)}>
      <h2>{t('pick.title')}</h2>
      {/* Which machine this list is of. A path alone cannot say — /home/you
          exists on the laptop and on the server, and picking the wrong one
          produces a card that fails much later, somewhere less obvious. */}
      <p className="muted small" data-testid="dirpick-world">
        {worldLabel(world, t)}
      </p>

      <div className="row" onKeyDown={onKey}>
        <input
          className="mono"
          value={typed}
          autoFocus
          spellCheck={false}
          data-testid="dirpick-path"
          aria-label={t('pick.path')}
          onFocus={() => setCursor(-1)}
          // Typing is the keyboard saying where it is, and it belongs in the
          // box. Without this the cursor keeps whatever a passing mouse left
          // on it — `onMouseEnter` sets it too — and Enter descends into the
          // row under the pointer instead of going to the path just typed.
          //
          // The focus handler above only looked like it covered this. It does
          // where clicking a row moves focus to that row's button, which is
          // what happens on Linux and Windows; on macOS a click leaves focus
          // in the box, no focus event follows, and the stale cursor wins.
          onChange={(e) => {
            setTyped(e.target.value);
            setCursor(-1);
          }}
        />
        <button
          data-testid="dirpick-ok"
          disabled={!listing || busy}
          onClick={() => listing && onPick(listing.path)}
        >
          {t('common.choose')}
        </button>
      </div>

      {/* The refusal keeps the list it failed to replace, so a typo costs a
          keystroke rather than your place. */}
      {error && (
        <p className="small" data-testid="dirpick-error">
          {error}
        </p>
      )}

      <div className="dirpick-list" ref={listRef} onKeyDown={onKey} data-testid="dirpick-list">
        {rows.length === 0 && !busy && (
          <p className="muted small pad" data-testid="dirpick-empty">
            {t('pick.empty')}
          </p>
        )}
        {rows.map((r, i) => (
          <button
            key={r.path}
            className={`dirpick-row${i === cursor ? ' on' : ''}${r.up ? ' up' : ''}`}
            data-testid={`dirpick-row-${r.name}`}
            onMouseEnter={() => setCursor(i)}
            onClick={() => go(r.path)}
          >
            {r.name}
          </button>
        ))}
      </div>

      {/* Said where it is true rather than discovered two dialogs later. */}
      {listing?.is_repo && (
        <p className="muted small" data-testid="dirpick-repo">
          {t('pick.isRepo')}
        </p>
      )}

      <div className="modal-actions">
        <button className="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  );
}
