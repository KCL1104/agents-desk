import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Attempt, AttemptEvent } from '../types';
import { STATUS_LABEL } from '../sections';

interface Props {
  attempt: Attempt;
  onClose: () => void;
}

type Pane = 'diff' | 'timeline';

/**
 * What an attempt changed, and what it did, without reading its terminal.
 *
 * A drawer beside the TUI rather than a screen instead of it. Reviewing ends
 * in one of two things — accepting the work, or telling the agent what is
 * still wrong — and the second is only cheap if the live session is still
 * right there to type into. A review screen that replaced the terminal would
 * turn a follow-up into a navigation problem, which is the point at which
 * this stops being a session manager and becomes a board.
 */
export function AttemptInspector({ attempt, onClose }: Props) {
  const [pane, setPane] = useState<Pane>('diff');
  const [diff, setDiff] = useState<string | null>(null);
  const [events, setEvents] = useState<AttemptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    void api
      .attemptDiff(attempt.id)
      .then(setDiff)
      .catch((e) => setError(String(e)));
    void api
      .attemptEvents(attempt.id)
      .then(setEvents)
      .catch(() => {
        /* the diff half is still worth showing */
      });
  }, [attempt.id]);

  // Read on open and whenever the attempt changes. Not on a timer: a diff
  // that reflows under you while you are reading it is worse than one you
  // asked to refresh.
  useEffect(refresh, [refresh]);

  return (
    <aside className="inspector" data-testid="inspector">
      <header className="inspector-head">
        <div className="view-toggle" role="tablist">
          <button
            role="tab"
            aria-selected={pane === 'diff'}
            className={pane === 'diff' ? 'active' : ''}
            data-testid="inspector-diff-tab"
            onClick={() => setPane('diff')}
          >
            變更
          </button>
          <button
            role="tab"
            aria-selected={pane === 'timeline'}
            className={pane === 'timeline' ? 'active' : ''}
            data-testid="inspector-timeline-tab"
            onClick={() => setPane('timeline')}
          >
            活動
          </button>
        </div>
        <span className="spacer" />
        <button className="icon" onClick={refresh} title="重新讀取" aria-label="重新讀取">
          ↻
        </button>
        <button className="icon" onClick={onClose} title="關閉" aria-label="關閉檢視">
          ✕
        </button>
      </header>

      <div className="inspector-meta mono small muted">
        <span>{attempt.branch}</span>
        <span title={attempt.base_sha}>base {attempt.base_sha.slice(0, 8)}</span>
        {attempt.outcome && <span className="inspector-frozen">已凍結</span>}
      </div>

      {error && (
        <p className="dialog-error" role="alert" data-testid="inspector-error">
          {error}
        </p>
      )}

      {pane === 'diff' ? (
        <DiffPane diff={diff} />
      ) : (
        <Timeline events={events} />
      )}
    </aside>
  );
}

function DiffPane({ diff }: { diff: string | null }) {
  if (diff === null) return <p className="muted small pad">讀取中…</p>;
  if (diff.trim() === '') {
    return (
      <p className="muted small pad" data-testid="diff-empty">
        這個 attempt 還沒有改動任何檔案。
      </p>
    );
  }
  return (
    <pre className="diff mono" data-testid="diff-body">
      {diff.split('\n').map((line, i) => (
        <span key={i} className={`diff-line ${lineKind(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * Which colour a diff line takes.
 *
 * `+++`/`---` are checked before `+`/`-` — they are file headers, not an
 * added and a removed line, and colouring them as changes makes every file in
 * the diff look like it both gained and lost a line.
 */
function lineKind(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}

function Timeline({ events }: { events: AttemptEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="muted small pad" data-testid="timeline-empty">
        還沒有活動。狀態回報只對 Claude Code 有效。
      </p>
    );
  }
  return (
    <ol className="timeline" data-testid="timeline">
      {events.map((e) => (
        <li key={e.id} className={`tl-row tl-${e.kind}`} data-kind={e.kind}>
          <span className="tl-time mono small muted">{clock(e.at)}</span>
          {e.kind === 'tool' ? (
            <>
              <span className="tl-tool mono">{e.tool}</span>
              <span className="tl-detail mono small muted">{e.detail}</span>
            </>
          ) : e.kind === 'status' ? (
            <span className="tl-status">{STATUS_LABEL[e.detail as never] ?? e.detail}</span>
          ) : (
            <span className="tl-prompt">{e.detail}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
