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
 * Mirrors `prompt.rs delivery_for`: only Claude Code's input conventions have
 * been measured, so only its sessions get a send button. Everyone else gets
 * the composed text to paste, exactly like the first prompt.
 */
export function followupSendable(agent: string): boolean {
  return agent === 'claude';
}
