import { isMeasured } from './agents';
import type { TFn } from './i18n';

/**
 * The review loop's model: tie a rendered diff line back to a file and line,
 * hold the feedback attached to those lines, and compose the batch into the
 * one message that goes back to the agent.
 *
 * Kept apart from the drawer component for the same reason `board.ts` is kept
 * apart from `Board.tsx` — this is the part with rules worth testing on their
 * own, and none of it needs React to be exercised.
 */

/** One rendered line of a unified diff, with what it can be tied back to. */
export interface DiffLine {
  text: string;
  kind: 'add' | 'del' | 'context' | 'meta' | 'hunk';
  /** The file this line belongs to, once inside a file's hunks. */
  file: string | null;
  /** Its position in the new file. A removed line carries the position the
      removal happened at, so feedback about it still points somewhere real. */
  line: number | null;
}

/**
 * Read a unified diff into lines that know where they are.
 *
 * `+++`/`---` are file headers, not changes — the same distinction the
 * colouring has always made — and the new-side path is what a comment should
 * name, because that is the file the agent will open to act on it. A file
 * that only exists on the old side (a deletion) falls back to the old path
 * rather than pointing at `/dev/null`.
 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file: string | null = null;
  let oldFile: string | null = null;
  let inHunk = false;
  let newLine = 0;

  for (const text of diff.split('\n')) {
    if (text.startsWith('diff ')) {
      file = null;
      oldFile = null;
      inHunk = false;
      out.push({ text, kind: 'meta', file: null, line: null });
    } else if (text.startsWith('--- ')) {
      oldFile = stripSide(text.slice(4));
      out.push({ text, kind: 'meta', file: null, line: null });
    } else if (text.startsWith('+++ ')) {
      file = stripSide(text.slice(4)) ?? oldFile;
      out.push({ text, kind: 'meta', file: null, line: null });
    } else if (text.startsWith('@@')) {
      inHunk = true;
      newLine = hunkStart(text);
      out.push({ text, kind: 'hunk', file, line: null });
    } else if (!inHunk) {
      // `index`, mode lines, and anything else between files.
      out.push({ text, kind: 'meta', file: null, line: null });
    } else if (text.startsWith('+')) {
      out.push({ text, kind: 'add', file, line: newLine });
      newLine += 1;
    } else if (text.startsWith('-')) {
      out.push({ text, kind: 'del', file, line: newLine });
    } else if (text.startsWith('\\')) {
      // `\ No newline at end of file`
      out.push({ text, kind: 'meta', file: null, line: null });
    } else {
      out.push({ text, kind: 'context', file, line: newLine });
      newLine += 1;
    }
  }
  return out;
}

/** `a/src/x.py` → `src/x.py`; `/dev/null` → nothing to name. */
function stripSide(path: string): string | null {
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/** The new-side start of `@@ -a,b +c,d @@`. */
function hunkStart(header: string): number {
  const m = /\+(\d+)/.exec(header);
  return m ? Number(m[1]) : 0;
}

/** Feedback attaches to code, not to headers or hunk markers. */
export function commentable(l: DiffLine): boolean {
  return (l.kind === 'add' || l.kind === 'del' || l.kind === 'context') && l.file !== null;
}

/** One run of a code line, as the diff tints it. */
export interface TintRun {
  text: string;
  /** `str` and `com` are the whole vocabulary — see `tint`. */
  cls: 'str' | 'com' | null;
}

/**
 * Texture for a code line: strings and comments, nothing else.
 *
 * Deliberately not syntax highlighting. A real highlighter needs to know
 * the language, and a half-right guess colors keywords wrongly in exactly
 * the place people read most carefully. Strings and comments are the two
 * token families every language agrees on, so they can be found by shape
 * alone — and marking just them breaks up the wall of uniform green a
 * large added file otherwise is.
 *
 * One left-to-right scan, so a `//` inside a string stays string and a
 * quote inside a comment stays comment. The conservative guards:
 * `://` never opens a comment (URLs), and `#` needs a following space
 * (`#fff`, `#!/bin/sh`, `#region` pass through untinted).
 *
 * The runs always concatenate back to the exact input — comment excerpts
 * and line matching elsewhere compare against the raw text.
 */
export function tint(text: string): TintRun[] {
  const runs: TintRun[] = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({ text: plain, cls: null });
      plain = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      // A string: to the matching unescaped quote, or the end of the line.
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      j = Math.min(text.length, j + 1);
      flush();
      runs.push({ text: text.slice(i, j), cls: 'str' });
      i = j;
      continue;
    }
    const twoAhead = text.slice(i, i + 2);
    if ((twoAhead === '//' && text[i - 1] !== ':') || (c === '#' && text[i + 1] === ' ')) {
      flush();
      runs.push({ text: text.slice(i), cls: 'com' });
      return runs;
    }
    // A block comment tints to its close when it closes on this line, and
    // to the end when it does not — the code after a closed one is code.
    const block = twoAhead === '/*' ? '*/' : text.slice(i, i + 4) === '<!--' ? '-->' : null;
    if (block !== null) {
      const close = text.indexOf(block, i + 2);
      const j = close === -1 ? text.length : close + block.length;
      flush();
      runs.push({ text: text.slice(i, j), cls: 'com' });
      i = j;
      continue;
    }
    plain += c;
    i += 1;
  }
  flush();
  return runs;
}

/**
 * Whether a file's slice of the diff starts folded.
 *
 * A deleted file's body says nothing its header does not; a slice past
 * this many lines is a wall nobody reads linearly — a lockfile, a
 * generated bundle — and walls between the reviewer and the real change
 * are how big diffs go unreviewed. Either way the fold is a starting
 * position, not a verdict: one click reopens it.
 */
export const COLLAPSE_OVER = 800;

export function autoCollapse(lineCount: number, meta: readonly string[]): boolean {
  return lineCount > COLLAPSE_OVER || meta.some((m) => m.startsWith('deleted file'));
}

/** One piece of feedback, tied to the line it was written against. */
export interface ReviewComment {
  file: string | null;
  line: number | null;
  /** The diff line as shown, quoted so the agent sees what was pointed at
      even after the worktree has moved on underneath the numbers. */
  excerpt: string;
  note: string;
}

/**
 * The batch as one message. One message rather than one per comment, because
 * each send is a turn: five turns would have the agent acting on the first
 * point before it has read the fifth.
 */
export function composeReview(comments: readonly ReviewComment[], t: TFn): string {
  const items = comments.map((c, i) => {
    const where =
      c.file === null ? '' : c.line === null ? c.file : `${c.file}:${c.line}`;
    return `${i + 1}. ${where}\n   > ${c.excerpt}\n   ${c.note}`;
  });
  return `${t('review.header')}\n\n${items.join('\n\n')}\n\n${t('review.footer')}`;
}

/**
 * Mirrors `prompt.rs delivery_for`: only the CLIs whose input conventions
 * have been measured get a send button. Everyone else gets the composed text
 * to paste, exactly like the first prompt.
 */
export function followupSendable(agent: string): boolean {
  return isMeasured(agent);
}
