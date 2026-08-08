import { test, expect } from '@playwright/test';
import { rollup } from '../src/timeline';
import type { AttemptEvent } from '../src/types';

let seq = 0;
function ev(over: Partial<AttemptEvent>): AttemptEvent {
  seq += 1;
  return { id: seq, attempt_id: 'a1', at: seq * 1000, kind: 'tool', tool: 'Bash', detail: null, ...over };
}

test.describe('the timeline rollup', () => {
  test('a run of the same tool is one row that keeps every detail', async () => {
    const rows = rollup([
      ev({ kind: 'prompt', tool: null, detail: '把它修好' }),
      ev({ tool: 'Read', detail: 'a.ts' }),
      ev({ tool: 'Read', detail: 'b.ts' }),
      ev({ tool: 'Read', detail: 'c.ts' }),
      ev({ tool: 'Edit', detail: 'a.ts' }),
    ]);
    expect(rows.map((r) => [r.kind, r.tool, r.count])).toEqual([
      ['prompt', null, 1],
      ['tool', 'Read', 3],
      ['tool', 'Edit', 1],
    ]);
    // The row shows the latest; the tooltip holds the whole run.
    expect(rows[1].detail).toBe('c.ts');
    expect(rows[1].details).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('the same tool on either side of another act stays two rows', async () => {
    const rows = rollup([
      ev({ tool: 'Bash', detail: 'cargo test' }),
      ev({ tool: 'Edit', detail: 'x.rs' }),
      ev({ tool: 'Bash', detail: 'cargo test' }),
    ]);
    expect(rows).toHaveLength(3);
  });

  test('a waiting status row measures what it held', async () => {
    const rows = rollup([
      ev({ kind: 'status', tool: null, detail: 'waiting_permission', at: 10_000 }),
      ev({ tool: 'Bash', detail: 'ls', at: 75_000 }),
      // The trailing wait has nothing after it: it may still be holding,
      // and a number would be a guess.
      ev({ kind: 'status', tool: null, detail: 'waiting_input', at: 80_000 }),
    ]);
    expect(rows[0].heldMs).toBe(65_000);
    expect(rows[2].heldMs).toBe(null);
  });

  test('an idle status is an ending, not a wait to price', async () => {
    const rows = rollup([
      ev({ kind: 'status', tool: null, detail: 'idle', at: 1000 }),
      ev({ tool: 'Bash', detail: 'ls', at: 9000 }),
    ]);
    expect(rows[0].heldMs).toBe(null);
  });
});
