import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Attempt, AttemptEvent } from '../types';
import { useT } from '../i18n';
import { STATUS_KEY } from '../sections';
import {
  commentable,
  composeReview,
  followupSendable,
  parseDiff,
  type DiffLine,
  type ReviewComment,
} from '../review';

interface Props {
  attempt: Attempt;
  /** Named so the merge button can say where the work is going. */
  baseBranch: string;
  onClose: () => void;
  /** The attempt ended: nothing is left to inspect here. */
  onDone: () => void;
  /** Start one of the repo's run scripts in this attempt's worktree. */
  onRunScript: (name: string) => void;
}

type Pane = 'diff' | 'timeline';

/** The line a comment is being written against. */
interface Picked {
  file: string | null;
  line: number | null;
  excerpt: string;
}

/**
 * What an attempt changed, and what it did, without reading its terminal.
 *
 * A drawer beside the TUI rather than a screen instead of it. Reviewing ends
 * in one of two things — accepting the work, or telling the agent what is
 * still wrong — and the second is only cheap if the live session is still
 * right there to type into. A review screen that replaced the terminal would
 * turn a follow-up into a navigation problem, which is the point at which
 * this stops being a session manager and becomes a board.
 *
 * Saying what is still wrong has a short path of its own: click a diff line,
 * attach feedback, and send the batch back into the session as one message.
 * The terminal is still the place for conversation; this is for the review
 * that reads the diff line by line.
 */
export function AttemptInspector({ attempt, baseBranch, onClose, onDone, onRunScript }: Props) {
  const t = useT();
  const [pane, setPane] = useState<Pane>('diff');
  const [diff, setDiff] = useState<string | null>(null);
  const [events, setEvents] = useState<AttemptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [runScripts, setRunScripts] = useState<string[]>([]);

  // The repo's run scripts, for the ▶ buttons. Read once per attempt: the
  // config is a file in the repository, and it does not move underneath an
  // open drawer any more than the base branch does.
  useEffect(() => {
    setRunScripts([]);
    if (attempt.outcome !== null) return;
    void api
      .listRunScripts(attempt.id)
      .then(setRunScripts)
      .catch(() => {
        /* a malformed config already fails the start, loudly */
      });
  }, [attempt.id, attempt.outcome]);

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

  // Feedback is written against one attempt's diff; carrying it across to
  // another attempt would send it somewhere it was never about.
  useEffect(() => {
    setComments([]);
    setPicked(null);
  }, [attempt.id]);

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
            {t('inspector.changes')}
          </button>
          <button
            role="tab"
            aria-selected={pane === 'timeline'}
            className={pane === 'timeline' ? 'active' : ''}
            data-testid="inspector-timeline-tab"
            onClick={() => setPane('timeline')}
          >
            {t('inspector.activity')}
          </button>
        </div>
        <span className="spacer" />
        <button className="icon" onClick={refresh} title={t('inspector.reload')} aria-label={t('inspector.reload')}>
          ↻
        </button>
        <button className="icon" onClick={onClose} title={t('common.close')} aria-label={t('inspector.closeView')}>
          ✕
        </button>
      </header>

      <div className="inspector-meta mono small muted">
        <span>{attempt.branch}</span>
        <span title={attempt.base_sha}>base {attempt.base_sha.slice(0, 8)}</span>
        {attempt.outcome && <span className="inspector-frozen">{t('inspector.frozen')}</span>}
      </div>

      {/* The repo's run scripts: a dev server or test watcher, one click,
          in this attempt's own worktree with its own port. */}
      {runScripts.length > 0 && attempt.outcome === null && (
        <div className="inspector-run" data-testid="run-scripts">
          {runScripts.map((name) => (
            <button
              key={name}
              className="chip mono"
              data-testid={`run-${name}`}
              title={t('inspector.runHint', { name })}
              onClick={() => onRunScript(name)}
            >
              ▶ {name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="dialog-error" role="alert" data-testid="inspector-error">
          {error}
        </p>
      )}

      {pane === 'diff' ? (
        <DiffPane diff={diff} comments={comments} onPick={setPicked} />
      ) : (
        <Timeline events={events} />
      )}

      {pane === 'diff' && (picked !== null || comments.length > 0) && (
        <Review
          attempt={attempt}
          picked={picked}
          comments={comments}
          onPick={setPicked}
          onChange={setComments}
          onSent={refresh}
          onProblem={setError}
        />
      )}

      {attempt.outcome === null && (
        <Finish attempt={attempt} baseBranch={baseBranch} onDone={onDone} />
      )}
    </aside>
  );
}

/**
 * The feedback being gathered, and the one way it leaves.
 *
 * The batch goes back as a single message — each send is a turn, and five
 * turns would have the agent acting on the first point before it has read
 * the fifth. Sending goes through the session's own terminal, so it lands
 * exactly as if it had been pasted there; for a CLI whose input conventions
 * are not measured the composed text is offered to copy instead, the same
 * honesty the first prompt has.
 */
function Review({
  attempt,
  picked,
  comments,
  onPick,
  onChange,
  onSent,
  onProblem,
}: {
  attempt: Attempt;
  picked: Picked | null;
  comments: ReviewComment[];
  onPick: (p: Picked | null) => void;
  onChange: (c: ReviewComment[]) => void;
  onSent: () => void;
  onProblem: (e: string | null) => void;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const canSend =
    attempt.outcome === null &&
    attempt.session_id !== null &&
    followupSendable(attempt.agent);

  const add = () => {
    if (!picked || note.trim() === '') return;
    onChange([...comments, { ...picked, note: note.trim() }]);
    setNote('');
    onPick(null);
  };

  const send = () => {
    if (!attempt.session_id) return;
    setBusy(true);
    onProblem(null);
    void api
      .sendFollowup(attempt.session_id, composeReview(comments, t))
      .then(() => {
        onChange([]);
        onPick(null);
        // The timeline now carries what was just asked.
        onSent();
      })
      .catch((e) => onProblem(String(e)))
      .finally(() => setBusy(false));
  };

  const copy = () => {
    void navigator.clipboard?.writeText(composeReview(comments, t));
    setCopied(true);
  };

  return (
    <div className="review" data-testid="review">
      {picked && (
        <div className="review-compose">
          <div className="mono small muted review-target">
            {picked.file === null
              ? ''
              : picked.line === null
                ? picked.file
                : `${picked.file}:${picked.line}`}
            <span className="review-excerpt"> {picked.excerpt}</span>
          </div>
          <textarea
            rows={2}
            autoFocus
            value={note}
            placeholder={t('review.placeholder')}
            data-testid="review-note"
            onChange={(e) => {
              setNote(e.target.value);
              setCopied(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
            }}
          />
          <div className="row">
            <button
              className="primary"
              disabled={note.trim() === ''}
              data-testid="review-add"
              onClick={add}
            >
              {t('review.add')}
            </button>
            <button
              onClick={() => {
                onPick(null);
                setNote('');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {comments.length > 0 && (
        <>
          <ul className="review-pending" data-testid="review-pending">
            {comments.map((c, i) => (
              <li key={i}>
                <span className="mono small muted">
                  {c.file === null ? '' : c.line === null ? c.file : `${c.file}:${c.line}`}
                </span>
                <span className="review-note-text small">{c.note}</span>
                <button
                  className="icon"
                  aria-label={t('review.remove')}
                  title={t('review.remove')}
                  onClick={() => onChange(comments.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="row review-actions">
            {canSend ? (
              <button
                className="primary"
                disabled={busy}
                data-testid="review-send"
                onClick={send}
              >
                {t('review.send', { count: comments.length })}
              </button>
            ) : (
              <button data-testid="review-copy" onClick={copy}>
                {copied ? t('attempt.copied') : t('review.copy')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
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
  const t = useT();
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
          {t('inspector.mergeInto', { branch: baseBranch })}
        </button>
        <button
          disabled={busy !== null}
          data-testid="open-pr"
          onClick={run('pr', () => api.openPr(attempt.id))}
        >
          {t('inspector.openPr')}
        </button>
        <span className="spacer" />
        <button
          className="danger"
          disabled={busy !== null}
          data-testid="discard-attempt"
          title={t('inspector.discardHint')}
          onClick={run('discard', () => api.finishAttempt(attempt.id, 'discarded'))}
        >
          {t('inspector.discard')}
        </button>
      </div>
    </footer>
  );
}

function DiffPane({
  diff,
  comments,
  onPick,
}: {
  diff: string | null;
  comments: readonly ReviewComment[];
  onPick: (p: Picked) => void;
}) {
  const t = useT();
  const lines = useMemo(() => (diff === null ? [] : parseDiff(diff)), [diff]);

  if (diff === null) return <p className="muted small pad">{t('common.loading')}</p>;
  if (diff.trim() === '') {
    return (
      <p className="muted small pad" data-testid="diff-empty">
        {t('inspector.noChanges')}
      </p>
    );
  }

  const noted = (l: DiffLine) =>
    comments.some((c) => c.file === l.file && c.line === l.line && c.excerpt === l.text);

  return (
    <pre className="diff mono" data-testid="diff-body">
      {lines.map((l, i) => (
        <span
          key={i}
          className={[
            'diff-line',
            classOf(l),
            commentable(l) ? 'commentable' : '',
            noted(l) ? 'noted' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          title={commentable(l) ? t('review.hint') : undefined}
          onClick={
            commentable(l)
              ? () => onPick({ file: l.file, line: l.line, excerpt: l.text })
              : undefined
          }
        >
          {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * Which colour a diff line takes. The parser has already told the file
 * headers apart from added and removed lines — colouring `+++` as an addition
 * is exactly the mistake it exists to prevent.
 */
function classOf(l: DiffLine): string {
  switch (l.kind) {
    case 'add':
      return 'add';
    case 'del':
      return 'del';
    case 'hunk':
      return 'hunk';
    case 'meta':
      return 'meta';
    default:
      return '';
  }
}

function Timeline({ events }: { events: AttemptEvent[] }) {
  const t = useT();
  if (events.length === 0) {
    return (
      <p className="muted small pad" data-testid="timeline-empty">
        {t('inspector.noActivity')}
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
            <span className="tl-status">
              {STATUS_KEY[e.detail as never] ? t(STATUS_KEY[e.detail as never]) : e.detail}
            </span>
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
