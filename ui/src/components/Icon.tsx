import type { JSX } from 'react';

/**
 * The drawn glyphs — the app's pictographic vocabulary in one stroke and
 * one weight, immune to the emoji-font roulette a unicode ⚠ or ▶ plays
 * across platforms. Punctuation-like marks (✕ ＋ ✓ ↩ ▸ ⎇ → $) stay text
 * on purpose: they read as type and should inherit it, exactly as words do.
 *
 * Every use is decorative. The meaning always rides a label, a title, or
 * the text beside the icon, so the SVG itself is hidden from AT.
 */
export type IconName =
  | 'warn'
  | 'bolt'
  | 'pencil'
  | 'flag'
  | 'play'
  | 'dot'
  | 'reload'
  | 'wrap';

const DRAWN: Record<IconName, JSX.Element> = {
  warn: (
    <>
      <path d="M8 2.2 14.7 13.4H1.3Z" fill="none" />
      <path d="M8 6.3v3.1" />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  bolt: <path d="M9.3 1.4 3.4 9.2h3.8l-.7 5.4 6-7.8H8.6Z" fill="currentColor" stroke="none" />,
  pencil: <path d="M11.2 2.6l2.2 2.2-7 7.1-3 .9.9-3Z" fill="none" />,
  flag: <path d="M4 14.5V2m0 .8h7.4l-2 2.7 2 2.7H4" fill="none" />,
  play: <path d="M5.2 3v10l8-5Z" fill="currentColor" stroke="none" />,
  dot: <circle cx="8" cy="8" r="4.2" fill="currentColor" stroke="none" />,
  reload: (
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" fill="none" />
      <path d="M11.2 1.9l.4 2.7 2.7-.5" fill="none" />
    </>
  ),
  wrap: (
    <path d="M12.8 3.2v3.4a2.2 2.2 0 0 1-2.2 2.2H4.6m2.6-2.8L4.4 8.8l2.8 2.8" fill="none" />
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {DRAWN[name]}
    </svg>
  );
}
