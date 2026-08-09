import type { TFn } from './i18n';

/**
 * Worlds, on the UI side: the stored-path prefix a card lives behind.
 * '' is local; 'wsl://Ubuntu' and 'ssh://devbox' name the others. The
 * scheme itself never appears on a keyboard again — people pick a world
 * and type plain paths; these helpers do the assembly.
 */
export type World = string;

const KEY = 'agentdesk.world';

/** The default world for new cards and sessions — a per-machine
    preference, like locale and theme. */
export function storedWorld(): World {
  return localStorage.getItem(KEY) ?? '';
}

export function rememberWorld(world: World) {
  if (world === '') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, world);
  // Dialogs read the default when they open; the chip needs to hear a
  // change made elsewhere — the theme event's precedent.
  window.dispatchEvent(new CustomEvent('agentdesk:world', { detail: world }));
}

export function worldLabel(world: World, t: TFn): string {
  if (world === '') return t('world.local');
  const m = /^(wsl|ssh):\/\/(.+)$/.exec(world);
  return m ? `${m[1].toUpperCase()}: ${m[2]}` : world;
}

/**
 * `\\wsl$\Ubuntu\home\me` (or `\\wsl.localhost\…`) → `wsl://Ubuntu/home/me`.
 *
 * The shape Windows Explorer copies and the folder picker returns. A path
 * that is not a WSL UNC comes back unchanged.
 */
export function normalizeUnc(input: string): string {
  const m = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)([\s\S]*)$/.exec(input.trim());
  if (!m) return input;
  const path = m[2].replace(/\\/g, '/');
  return `wsl://${m[1]}${path === '' ? '/' : path}`;
}

/**
 * The stored path for what the person typed, under the world they picked.
 *
 * Full schemes and WSL UNC paths pass through regardless of the selected
 * world — pasting something explicit always wins over a dropdown.
 */
export function composePath(world: World, input: string): string {
  const raw = input.trim();
  const unc = normalizeUnc(raw);
  if (unc !== raw) return unc;
  if (/^(wsl|ssh):\/\//.test(raw) || world === '') return raw;
  return `${world}${raw.startsWith('/') ? '' : '/'}${raw}`;
}
