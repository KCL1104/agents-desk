import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { worldLabel, type World } from '../worlds';

/**
 * The per-card override of the world: a select fed by the same
 * enumeration the bottom-left picker uses. Both create dialogs carry it,
 * because a world belongs to the thing being created, never to the app.
 */
export function WorldSelect({
  value,
  onChange,
  testid,
}: {
  value: World;
  onChange: (w: World) => void;
  testid: string;
}) {
  const t = useT();
  const [worlds, setWorlds] = useState<{ wsl: string[]; ssh: string[] } | null>(null);

  useEffect(() => {
    void api.listWorlds().then(setWorlds).catch(() => setWorlds({ wsl: [], ssh: [] }));
  }, []);

  const options: World[] = [
    '',
    ...(worlds?.wsl ?? []).map((d) => `wsl://${d}`),
    ...(worlds?.ssh ?? []).map((a) => `ssh://${a}`),
  ];
  // The remembered default may name a world the enumeration no longer
  // has; the select must still show it rather than silently moving.
  if (value !== '' && !options.includes(value)) options.push(value);

  return (
    <>
      <label>{t('world.where')}</label>
      <select value={value} data-testid={testid} onChange={(e) => onChange(e.target.value)}>
        {options.map((w) => (
          <option key={w === '' ? 'local' : w} value={w}>
            {worldLabel(w, t)}
          </option>
        ))}
      </select>
    </>
  );
}
