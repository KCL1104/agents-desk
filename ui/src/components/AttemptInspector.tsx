import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Attempt, AttemptEvent } from '../types';
import { STATUS_LABEL } from '../sections';

interface Props {
  attempt: Attempt;
  /** Named so the merge button can say where the work is going. */
  baseBranch: string;
  onClose: () => void;
  /** The attempt ended: nothing is left to inspect here. */
  onDone: () => void;
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
export function AttemptInspector({ attempt, baseBranch, onClose, onDone }: Props) {
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

      {pane === 'diff' ? <DiffPane diff={diff} /> : <Timeline events={events} />}

      {attempt.outcome === null && (
        <Finish attempt={attempt} baseBranch={baseBranch} onDone={onDone} />
      )}
    </aside>
  );
}

/**
 * The two ways an attempt ends, and the one way it is thrown away.
 *
 * This is where it stops. Reviewing a pull request, chasing its checks and
 * merging it are somebody else's tool and a much larger one — trying to be
 * that as well would dilute the part of this that is actually deep.
 *
 * Merging closes the attempt out and takes the worktree back. Opening a pull
 * request deliberately does not: review is exactly when there is still
 * something to change, and the worktree is where changing it happens.
 */
function Finish({
  attempt,
  baseBranch,
  onDone,
}: {
  attempt: Attempt;
  baseBranch: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const run = (what: string, fn: () => Promise<unknown>) => () => {
    setBusy(what);
    setProblem(null);
    void fn()
      .then((r) => {
        if (what === 'pr' && typeof r === 'string') setPrUrl(r);
        if (what === 'merge' || what === 'discard') onDone();
      })
      // Every refusal here is one that would otherwise lose work quietly —
      // uncommitted changes, the wrong branch checked out — so it is shown
      // in full rather than summarised.
      .catch((e) => setProblem(String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <footer className="inspector-foot">
      {problem && (
        <p className="dialog-error" role="alert" data-testid="finish-error">
          {problem}
        </p>
      )}
      {prUrl && (
        <p className="mono small" data-testid="pr-url">
          {prUrl}
        </p>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={busy !== null}
          data-testid="merge-attempt"
          onClick={run('merge', () => api.mergeAttempt(attempt.id))}
        >
          合併回 {baseBranch}
        </button>
        <button
          disabled={busy !== null}
          data-testid="open-pr"
          onClick={run('pr', () => api.openPr(attempt.id))}
        >
          push + 開 PR
        </button>
        <span className="spacer" />
        <button
          className="danger"
          disabled={busy !== null}
          data-testid="discard-attempt"
          title="關掉這個 attempt 並收回 worktree。變更會凍結保留。"
          onClick={run('discard', () => api.finishAttempt(attempt.id, 'discarded'))}
        >
          丟棄
        </button>
      </div>
    </footer>
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
