import { test, expect } from '@playwright/test';
import {
  commentable,
  composeReview,
  followupSendable,
  parseDiff,
  tint,
  type ReviewComment,
} from '../src/review';
import { translator } from '../src/i18n/messages';

const zh = translator('zh-TW');

const DIFF = [
  'diff --git a/src/auth.py b/src/auth.py',
  'index 1111111..2222222 100644',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -10,3 +12,4 @@ def login():',
  ' def login():',
  '-    return None',
  '+    if ok:',
  '+        return session',
  'diff --git a/new.rs b/new.rs',
  '--- /dev/null',
  '+++ b/new.rs',
  '@@ -0,0 +1,1 @@',
  '+fn main() {}',
].join('\n');

test.describe('the diff, read back into places feedback can point at', () => {
  /**
   * A comment has to name the file and line the agent should open. The new
   * side is the one that exists in the worktree, so its numbering is the one
   * that means anything — starting where the hunk header says, not at 1.
   */
  test('lines know their file and their new-side line number', () => {
    const lines = parseDiff(DIFF);
    const at = (text: string) => lines.find((l) => l.text === text)!;

    expect(at(' def login():')).toMatchObject({ kind: 'context', file: 'src/auth.py', line: 12 });
    // A removed line has no new-side number of its own; it carries the
    // position the removal happened at, so feedback still points somewhere.
    expect(at('-    return None')).toMatchObject({ kind: 'del', file: 'src/auth.py', line: 13 });
    expect(at('+    if ok:')).toMatchObject({ kind: 'add', file: 'src/auth.py', line: 13 });
    expect(at('+        return session')).toMatchObject({ kind: 'add', line: 14 });
  });

  /** The second file's numbering starts over — one running count would let
      feedback on file two point into file one. */
  test('a new file starts its own count and names its own path', () => {
    const lines = parseDiff(DIFF);
    const added = lines.find((l) => l.text === '+fn main() {}')!;
    expect(added).toMatchObject({ kind: 'add', file: 'new.rs', line: 1 });
  });

  /** `+++`/`---` are headers, not changes — the same distinction the diff
      colouring has always had to make. */
  test('headers and hunk markers take no feedback', () => {
    const lines = parseDiff(DIFF);
    for (const l of lines) {
      if (l.kind === 'meta' || l.kind === 'hunk') {
        expect(commentable(l)).toBe(false);
      }
    }
    expect(commentable(lines.find((l) => l.text === '+    if ok:')!)).toBe(true);
    expect(commentable(lines.find((l) => l.text === '-    return None')!)).toBe(true);
  });

  /**
   * The batch leaves as one message — each send is a turn, and five turns
   * would have the agent acting on point one before it has read point five.
   * Every comment quotes its line, because the worktree may have moved on
   * underneath the numbers by the time the agent reads it.
   */
  test('the batch composes into one numbered message that quotes its lines', () => {
    const comments: ReviewComment[] = [
      { file: 'src/auth.py', line: 13, excerpt: '+    if ok:', note: '這裡少了 else' },
      { file: 'new.rs', line: 1, excerpt: '+fn main() {}', note: '要有測試' },
    ];
    const msg = composeReview(comments, zh);

    expect(msg).toContain('[Marol 檢視回饋]');
    expect(msg).toContain('1. src/auth.py:13');
    expect(msg).toContain('> +    if ok:');
    expect(msg).toContain('這裡少了 else');
    expect(msg).toContain('2. new.rs:1');
    expect(msg.indexOf('1. src/auth.py')).toBeLessThan(msg.indexOf('2. new.rs'));
    // And it ends by saying what to do with the feedback.
    expect(msg.trimEnd().endsWith('commit 在這個分支上。')).toBe(true);
  });

  /** Mirrors prompt.rs: only the CLI whose conventions were measured is sent
      to directly; everyone else's button is a copy. */
  test('only the measured CLI gets a send button', () => {
    expect(followupSendable('claude')).toBe(true);
    for (const other of ['codex', 'gemini', 'aider']) {
      expect(followupSendable(other)).toBe(false);
    }
  });
});

test.describe('tint — strings and comments, nothing else', () => {
  const concat = (s: string) => tint(s).map((r) => r.text).join('');

  test('strings and line comments are found by shape', () => {
    const runs = tint('+  const x = "hello"; // greet');
    expect(runs.find((r) => r.cls === 'str')?.text).toBe('"hello"');
    expect(runs.find((r) => r.cls === 'com')?.text).toBe('// greet');
  });

  test('the conservative guards hold: URLs, hex colors, shebangs stay code', () => {
    expect(tint('+  fetch("https://example.com")').filter((r) => r.cls === 'com')).toHaveLength(0);
    expect(tint('+  color: #ffffff;').filter((r) => r.cls === 'com')).toHaveLength(0);
    expect(tint('+#!/bin/sh').filter((r) => r.cls === 'com')).toHaveLength(0);
    // But a real python comment — hash, space — tints.
    expect(tint('+x = 1  # count').find((r) => r.cls === 'com')?.text).toBe('# count');
  });

  test('a // inside a string stays string; a quote inside a comment stays comment', () => {
    const url = tint('+  s = "a // b"');
    expect(url.find((r) => r.cls === 'str')?.text).toBe('"a // b"');
    expect(url.filter((r) => r.cls === 'com')).toHaveLength(0);
    const q = tint("+  // it's fine");
    expect(q.find((r) => r.cls === 'com')?.text).toBe("// it's fine");
  });

  test('a block comment that closes mid-line releases the code after it', () => {
    const runs = tint('+  a /* note */ b');
    expect(runs.find((r) => r.cls === 'com')?.text).toBe('/* note */');
    expect(runs[runs.length - 1]).toEqual({ text: ' b', cls: null });
  });

  test('the runs always concatenate back to the exact input', () => {
    for (const line of [
      '+  const x = "hello"; // greet',
      "-  escaped = 'it\\'s'",
      '+  /* open ended',
      '   plain context line',
      '+  weird = `tpl ${x}` // tail',
      '+#!/bin/sh',
    ]) {
      expect(concat(line)).toBe(line);
    }
  });
});
