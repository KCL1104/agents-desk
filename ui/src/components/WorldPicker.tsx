import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { rememberWorld, storedWorld, worldLabel, type World } from '../worlds';

/**
 * The bottom-left world switch — VS Code's remote indicator, translated
 * for a desk where worlds coexist. Picking here does not put the app
 * "into" a world (the board mixes them by design, each card wearing its
 * badge); it sets where new cards and sessions open by default, and the
 * create dialogs still offer a per-card override.
 *
 * Discovery is enumeration, never invention: WSL distros from `wsl -l`,
 * SSH aliases from the person's own config. Probing is lazy — a pick
 * asks that one world for its claude and wears the answer (or the whole
 * refusal) right on the row; startup never touches a remote.
 */
export function WorldPicker() {
  const t = useT();
  const [world, setWorld] = useState<World>(storedWorld);
  const [open, setOpen] = useState(false);
  const [worlds, setWorlds] = useState<{ wsl: string[]; ssh: string[] } | null>(null);
  const [probes, setProbes] = useState<
    Record<string, 'probing' | { claude: string | null; error: string | null }>
  >({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.listWorlds().then(setWorlds).catch(() => setWorlds({ wsl: [], ssh: [] }));
    const away = (e: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const pickWorld = (w: World) => {
    setWorld(w);
    rememberWorld(w);
    // The menu stays open so the probe's answer lands where the click
    // was — closing on pick would make the result a mystery toast.
    setProbes((p) => ({ ...p, [w]: 'probing' }));
    void api
      .probeWorld(w)
      .then((res) => setProbes((p) => ({ ...p, [w]: res })))
      .catch((e) =>
        setProbes((p) => ({ ...p, [w]: { claude: null, error: String(e) } })),
      );
  };

  const rows: World[] = [
    '',
    ...(worlds?.wsl ?? []).map((d) => `wsl://${d}`),
    ...(worlds?.ssh ?? []).map((a) => `ssh://${a}`),
  ];
  // A remembered default from a config that no longer lists it still
  // deserves a row — silently dropping it would strand the chip's label.
  if (world !== '' && !rows.includes(world)) rows.push(world);

  return (
    <div className="world" ref={rootRef}>
      {open && (
        <div className="world-menu" role="menu" data-testid="world-menu">
          <p className="world-menu-hint muted small">{t('world.hint')}</p>
          {worlds === null ? (
            <p className="muted small world-menu-hint">{t('common.loading')}</p>
          ) : (
            rows.map((w) => {
              const probe = probes[w];
              return (
                <button
                  key={w === '' ? 'local' : w}
                  role="menuitemradio"
                  aria-checked={w === world}
                  className={`world-row${w === world ? ' active' : ''}`}
                  data-testid={`world-${w === '' ? 'local' : w.replace('://', '-')}`}
                  onClick={() => pickWorld(w)}
                >
                  <span className="world-row-name">
                    {w === world ? '✓ ' : ''}
                    {worldLabel(w, t)}
                  </span>
                  {probe === 'probing' ? (
                    <span className="muted small">{t('world.probing')}</span>
                  ) : probe?.error != null ? (
                    <span className="world-err small">{probe.error}</span>
                  ) : probe != null ? (
                    <span className="muted small mono">
                      {probe.claude ?? t('world.noClaude')}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      )}
      <button
        className="world-chip mono"
        data-testid="world-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('world.pick')}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⊕</span> {worldLabel(world, t)}
      </button>
    </div>
  );
}
