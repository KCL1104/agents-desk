import type { AttemptEvent } from './types';

/**
 * The timeline, prepared for reading.
 *
 * The record in SQLite is complete and stays complete — every tool call
 * its own row. Reading is a different job: an agent grinding through a
 * dozen Reads in a row is one act, not twelve lines between the reader
 * and the next real event, so consecutive calls to the same tool roll up
 * into one row that still carries every detail. And a waiting status row
 * gains the one number the record alone cannot show: how long it held —
 * the distance to whatever happened next.
 */
export interface TimelineRow {
  kind: AttemptEvent['kind'];
  tool: string | null;
  /** The latest detail of the run — what the card would have shown last. */
  detail: string | null;
  /** When the run began. */
  at: number;
  /** How many consecutive same-tool calls this row stands for. */
  count: number;
  /** Every detail in the run, oldest first, for the tooltip. */
  details: string[];
  /** For a waiting status row: how long until the next event ended it.
      `null` when nothing has happened since — it may still be holding. */
  heldMs: number | null;
}

/** The statuses whose duration is the reader's own cost. */
const HELD = new Set(['waiting_permission', 'waiting_input', 'awaiting_trust']);

export function rollup(events: readonly AttemptEvent[]): TimelineRow[] {
  const out: TimelineRow[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const last = out[out.length - 1];
    if (
      e.kind === 'tool' &&
      last !== undefined &&
      last.kind === 'tool' &&
      last.tool === e.tool
    ) {
      last.count += 1;
      last.detail = e.detail;
      if (e.detail !== null) last.details.push(e.detail);
      continue;
    }
    out.push({
      kind: e.kind,
      tool: e.tool,
      detail: e.detail,
      at: e.at,
      count: 1,
      details: e.detail !== null ? [e.detail] : [],
      heldMs:
        e.kind === 'status' && e.detail !== null && HELD.has(e.detail) && i + 1 < events.length
          ? Math.max(0, events[i + 1].at - e.at)
          : null,
    });
  }
  return out;
}
