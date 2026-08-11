import { useEffect, useRef, useState } from 'react';
import type { MessageKey } from './i18n';
import type { SessionMeta, Status } from './types';

export type Section = 'waiting' | 'working' | 'idle' | 'done';

export const SECTION_KEY: Record<Section, MessageKey> = {
  waiting: 'section.waiting',
  working: 'section.working',
  idle: 'section.idle',
  done: 'section.done',
};

/**
 * What each status is called on screen. One copy, because the sidebar, the
 * overview and the board all name the same thing and a status that reads
 * differently depending on where you are looking is a bug in itself.
 *
 * These are message keys rather than text: the same reasoning applies across
 * languages, so the single copy has to live at the key level.
 */
export const STATUS_KEY: Record<Status, MessageKey> = {
  starting: 'status.starting',
  awaiting_trust: 'status.awaiting_trust',
  running: 'status.running',
  waiting_permission: 'status.waiting_permission',
  waiting_input: 'status.waiting_input',
  idle: 'status.idle',
  saved: 'status.saved',
  detached: 'status.detached',
  exited: 'status.exited',
};

/**
 * How long a session must stay calm before it is allowed to leave 開發中.
 *
 * `Stop` fires at the end of every turn, so a session you are actively
 * chatting with would otherwise hop between sections on each reply — and the
 * row you were about to click moves out from under the cursor.
 */
export const SETTLE_MS = 2500;

/** Where a session belongs, ignoring any settling delay.
 *
 *  等你 holds exactly `NEEDS_YOU` — the same set the ⚠ banner counts, so
 *  the section's number and the badge's can never disagree. `idle` is its
 *  own tier: a turn that ended is your move, but nothing is blocked, and
 *  filing it with the blocked rows made 「等你 (4)」 sit over a banner
 *  saying ⚠ 2. */
export function sectionOf(s: SessionMeta): Section {
  if (s.completed) return 'done';
  switch (s.status) {
    case 'starting':
    case 'running':
      return 'working';
    // A new worktree's folder-trust prompt is a human being waited on, the
    // same as the other two, so it files the same way.
    case 'awaiting_trust':
    case 'waiting_permission':
    case 'waiting_input':
      return 'waiting';
    case 'idle':
      return 'idle';
    // Running, just not watched. Filing it under 完成 would repeat in the
    // grouping the same lie the label used to tell; 開發中 is where a
    // working agent belongs, whoever is or is not looking at it.
    case 'detached':
      return 'working';
    case 'saved':
    case 'exited':
      return 'done';
  }
}

/**
 * A move that must not wait.
 *
 * Being blocked on a permission decision costs the user real time, so it
 * overrides the settle window. So does the folder-trust prompt: the agent has
 * not started at all until it is answered, which is the most expensive kind
 * of waiting there is.
 */
function isUrgent(status: Status): boolean {
  return status === 'waiting_permission' || status === 'awaiting_trust';
}

/**
 * The section each session is *displayed* in, which lags the raw status.
 *
 * Four rules, in order:
 *   1. An explicit user action — marking a session done — takes effect at
 *      once. It is a command, not a status flap, so neither the pin nor the
 *      settle window applies to it.
 *   2. The selected session never moves. You are looking at it; the sidebar
 *      should not rearrange itself around your cursor. This holds even for a
 *      permission prompt: the prompt is already on screen in front of you,
 *      and the waiting badge still counts it, so moving the row adds noise
 *      and no information.
 *   3. For any other session, a move into a blocked state happens at once.
 *   4. Every other move waits out `SETTLE_MS`, so end-of-turn flapping never
 *      reaches the screen.
 */
export function useSections(
  sessions: SessionMeta[],
  activeId: string | null,
): Record<string, Section> {
  const [display, setDisplay] = useState<Record<string, Section>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;

    setDisplay((prev) => {
      const next: Record<string, Section> = {};
      let changed = false;

      for (const s of sessions) {
        const target = sectionOf(s);
        const current = prev[s.id];

        // First sight: place it directly, no settling.
        if (current === undefined) {
          next[s.id] = target;
          changed = true;
          continue;
        }

        next[s.id] = current;

        // Rule 1: an explicit completion toggle is obeyed immediately.
        const explicit = s.completed !== (current === 'done');
        if (explicit) {
          next[s.id] = target;
          changed = true;
          const t = pending.get(s.id);
          if (t) {
            clearTimeout(t);
            pending.delete(s.id);
          }
          continue;
        }

        // A session with no terminal left has nothing to flap: its state is
        // final, so neither the pin nor the settle window earns its keep.
        // Without this, closing the selected session leaves an 已關閉 row
        // pinned under 等待輸入 for as long as it stays selected.
        if (!s.live && target === 'done') {
          next[s.id] = target;
          changed = true;
          const t = pending.get(s.id);
          if (t) {
            clearTimeout(t);
            pending.delete(s.id);
          }
          continue;
        }

        // Rule 2: pinned while selected.
        if (s.id === activeId) {
          const t = pending.get(s.id);
          if (t) {
            clearTimeout(t);
            pending.delete(s.id);
          }
          continue;
        }

        if (target === current) {
          const t = pending.get(s.id);
          if (t) {
            clearTimeout(t);
            pending.delete(s.id);
          }
          continue;
        }

        // Rule 3: blocked states jump the queue.
        if (isUrgent(s.status)) {
          next[s.id] = target;
          changed = true;
          const t = pending.get(s.id);
          if (t) {
            clearTimeout(t);
            pending.delete(s.id);
          }
          continue;
        }

        // Rule 4: settle. Re-arm only if nothing is already waiting, so a
        // stream of updates does not keep pushing the move further out.
        if (!pending.has(s.id)) {
          const id = s.id;
          pending.set(
            id,
            setTimeout(() => {
              pending.delete(id);
              setDisplay((d) => ({ ...d, [id]: target }));
            }, SETTLE_MS),
          );
        }
      }

      // Drop rows for sessions that no longer exist.
      for (const id of Object.keys(prev)) {
        if (!(id in next)) {
          const t = pending.get(id);
          if (t) {
            clearTimeout(t);
            pending.delete(id);
          }
          changed = true;
        }
      }

      return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
    });
  }, [sessions, activeId]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return display;
}

/** A token count, compacted the way people say it: 812, 9.8k, 279k, 2.6M.
 *  One decimal only while it still means something; the exact figure lives
 *  in the tooltip beside every use. */
export function tokens(n: number): string {
  const short = (v: number, unit: string) =>
    `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))}${unit}`;
  if (n < 1000) return String(n);
  if (n < 999_500) return short(n / 1000, 'k');
  return short(n / 1e6, 'M');
}

/** Elapsed time, in the compact form the sidebar uses. */
export function elapsed(sinceMs: number, now: number = Date.now()): string {
  if (!sinceMs) return '';
  const secs = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}
