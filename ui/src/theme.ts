/**
 * Themes: the eleven tokens the whole interface already speaks, made
 * swappable.
 *
 * Presets carry hand-tuned values for every token — the same discipline the
 * default palette has always had, where the quiet text tiers are chosen
 * against every surface they touch. A custom theme asks the user for only
 * the six colors that carry meaning (background, foreground, accent, and
 * the three semantics) and derives the in-between tiers by mixing, with the
 * editor showing live contrast so the AA floor the stylesheet documents
 * stays visible while it is being spent.
 *
 * Everything else in the CSS is `color-mix()` over these tokens, so hovers,
 * tints and armed states follow whatever theme is active without any theme
 * knowing about them.
 */

export interface ThemeColors {
  bg: string;
  bg2: string;
  bg3: string;
  line: string;
  fg: string;
  fgDim: string;
  fgFaint: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
}

/** The six colors a custom theme is built from. */
export interface Primaries {
  bg: string;
  fg: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
}

export interface Theme {
  /** Preset id, or 'custom'. */
  id: string;
  /** Light themes flip the terminal's ANSI ramp. */
  light: boolean;
  colors: ThemeColors;
}

export type StoredTheme = { preset: string } | { preset: 'custom'; light: boolean; primaries: Primaries };

const KEY = 'agentdesk.theme';

/* ------------------------------------------------------------------ */
/* Color math                                                          */
/* ------------------------------------------------------------------ */

function hex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
}

function rgb(c: string): [number, number, number] {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `t` of the way from `a` to `b`, in sRGB — the same space color-mix uses. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg_, bb] = rgb(b);
  return `#${hex(ar + (br - ar) * t)}${hex(ag + (bg_ - ag) * t)}${hex(ab + (bb - ab) * t)}`;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(c: string): number {
  const [r, g, b] = rgb(c);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text color for a solid `on` surface: near-black or white, whichever reads. */
export function onColor(surface: string): string {
  return contrast(surface, '#0d1017') >= contrast(surface, '#ffffff') ? '#0d1017' : '#ffffff';
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

/**
 * The five in-between tiers, from the two colors that anchor them.
 *
 * Ratios are chosen so that deriving from the default preset's bg/fg lands
 * within a couple of hex points of its hand-tuned values — the formula is
 * the tuning, generalized.
 */
export function derive(p: Primaries): ThemeColors {
  return {
    bg: p.bg,
    bg2: mix(p.bg, p.fg, 0.02),
    bg3: mix(p.bg, p.fg, 0.05),
    line: mix(p.bg, p.fg, 0.11),
    fg: p.fg,
    fgDim: mix(p.bg, p.fg, 0.63),
    fgFaint: mix(p.bg, p.fg, 0.54),
    accent: p.accent,
    ok: p.ok,
    warn: p.warn,
    err: p.err,
  };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export const PRESETS: Theme[] = [
  {
    // The default: the ultramarine desk. A warm near-black ground — ink
    // with blood in it, not server-room gray — and one committed jewel of
    // an accent: electric ultramarine at full saturation, where the old
    // periwinkle was any editor theme's polite blue. The semantic trio
    // keeps its hues (they are load-bearing); --merged derives into a
    // deeper violet-crimson on its own. Values mirror styles.css :root.
    id: 'ink',
    light: false,
    colors: {
      bg: '#161214', bg2: '#1b1719', bg3: '#221c1f', line: '#322a2e',
      fg: '#ebe6e3', fgDim: '#a69ba0', fgFaint: '#90858b',
      accent: '#6f7dff', ok: '#7dc48d', warn: '#e0af68', err: '#e26d72',
    },
  },
  {
    // Light. The semantics darken to keep their AA on paper.
    id: 'paper',
    light: true,
    colors: {
      bg: '#f6f6f4', bg2: '#efefec', bg3: '#e7e7e3', line: '#d3d3cd',
      fg: '#1d1d22', fgDim: '#5a5a64', fgFaint: '#6b6b74',
      accent: '#3556b8', ok: '#22713d', warn: '#8a5a12', err: '#b03340',
    },
  },
  {
    id: 'pine',
    light: false,
    colors: {
      bg: '#121614', bg2: '#161b18', bg3: '#1c221e', line: '#2a332d',
      fg: '#e4e9e5', fgDim: '#98a49b', fgFaint: '#849087',
      accent: '#8fc7a2', ok: '#79c08a', warn: '#dcb56e', err: '#e07a75',
    },
  },
  {
    id: 'wisteria',
    light: false,
    colors: {
      bg: '#141219', bg2: '#18161e', bg3: '#1e1c25', line: '#2d2a37',
      fg: '#e8e6ee', fgDim: '#9d99aa', fgFaint: '#8a8695',
      accent: '#b39aef', ok: '#7fbd8e', warn: '#ddad6c', err: '#e0748f',
    },
  },
  {
    id: 'sunset',
    light: false,
    colors: {
      bg: '#181310', bg2: '#1d1714', bg3: '#241d19', line: '#362c25',
      fg: '#ece6e1', fgDim: '#a89e96', fgFaint: '#948a82',
      accent: '#e8a568', ok: '#88bd85', warn: '#e0af68', err: '#e06c75',
    },
  },
];

export const DEFAULT_PRIMARIES: Primaries = {
  bg: '#161214', fg: '#ebe6e3', accent: '#6f7dff',
  ok: '#7dc48d', warn: '#e0af68', err: '#e26d72',
};

/* ------------------------------------------------------------------ */
/* Storage and application                                             */
/* ------------------------------------------------------------------ */

export function loadStored(): StoredTheme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as StoredTheme;
  } catch {
    /* a corrupt value is the default theme */
  }
  return { preset: 'ink' };
}

export function resolve(stored: StoredTheme): Theme {
  if (stored.preset === 'custom' && 'primaries' in stored) {
    return { id: 'custom', light: stored.light, colors: derive(stored.primaries) };
  }
  return PRESETS.find((p) => p.id === stored.preset) ?? PRESETS[0];
}

let current: Theme = PRESETS[0];

export function currentTheme(): Theme {
  return current;
}

/** Set the tokens on the root, remember the choice, tell the terminals. */
export function applyTheme(stored: StoredTheme): Theme {
  const theme = resolve(stored);
  current = theme;
  const c = theme.colors;
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--bg', c.bg);
  set('--bg-2', c.bg2);
  set('--bg-3', c.bg3);
  set('--line', c.line);
  set('--fg', c.fg);
  set('--fg-dim', c.fgDim);
  set('--fg-faint', c.fgFaint);
  set('--accent', c.accent);
  set('--ok', c.ok);
  set('--warn', c.warn);
  set('--err', c.err);
  // Text on the solid accent surface cannot be mixed — it is picked, by
  // whichever of near-black or white actually reads on the chosen color.
  set('--on-accent', onColor(c.accent));
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* running without storage is fine; the theme just does not persist */
  }
  window.dispatchEvent(new CustomEvent('agentdesk:theme'));
  return theme;
}

/* ------------------------------------------------------------------ */
/* The terminal's share                                                */
/* ------------------------------------------------------------------ */

const ANSI_DARK = {
  // Warmed to sit on the ultramarine desk's ground; blue is the accent's
  // own family so a TUI's links and headers speak the app's blue.
  black: '#221c1f', brightBlack: '#5f5760',
  red: '#e26d72', brightRed: '#ff7d84',
  green: '#7dc48d', brightGreen: '#93daa3',
  yellow: '#e0af68', brightYellow: '#f0c584',
  blue: '#8a96ff', brightBlue: '#a4adff',
  magenta: '#bb9af7', brightMagenta: '#d0b4ff',
  cyan: '#56b6c2', brightCyan: '#6fd3e0',
  white: '#cdc6c8', brightWhite: '#ffffff',
};

/** On paper the classic ANSI brights wash out; every slot darkens. */
const ANSI_LIGHT = {
  black: '#1d1d22', brightBlack: '#4a4a54',
  red: '#b03340', brightRed: '#8f2833',
  green: '#22713d', brightGreen: '#1b5c32',
  yellow: '#8a5a12', brightYellow: '#71490e',
  blue: '#3556b8', brightBlue: '#2a4494',
  magenta: '#7a4bd6', brightMagenta: '#6339b3',
  cyan: '#20707e', brightCyan: '#195a66',
  white: '#8f8f98', brightWhite: '#1d1d22',
};

/** What xterm should paint, for the active theme. */
export function xtermTheme(theme: Theme = current) {
  const c = theme.colors;
  return {
    background: c.bg,
    foreground: c.fg,
    cursor: c.accent,
    selectionBackground: mix(c.bg, c.accent, theme.light ? 0.35 : 0.3),
    ...(theme.light ? ANSI_LIGHT : ANSI_DARK),
  };
}
