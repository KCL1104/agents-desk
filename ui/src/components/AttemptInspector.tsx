import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AttemptStat, type Checkpoint } from '../api';
import type { Attempt, AttemptEvent, SessionMeta } from '../types';
import { useT } from '../i18n';
import { useArmed } from './armed';
import { Icon } from './Icon';
import { FriendlyError } from './FriendlyError';
import { elapsed, STATUS_KEY } from '../sections';
import { rollup } from '../timeline';
import {
  autoCollapse,
  commentable,
  composeReview,
  followupSendable,
  parseDiff,
  tint,
  type DiffLine,
  type ReviewComment,
} from '../review';
import { nextAction, NEXT_KEY, type NextAction } from '../next';

interface Props {
  attempt: Attempt;
  /** The attempt's live session, if any — for what only a session knows:
      whether the agent is mid-turn, and whether a message is queued. */
  session: SessionMeta | null;
  /** Named so the merge button can say where the work is going. */
  baseBranch: string;
  /** The feedback batch in progress, held by the App keyed per attempt.
      The drawer unmounts on ⌘I and follows focus between panes — if the
      batch lived here, either act would destroy typed feedback, which is
      exactly the loss the dialogs' dirty-guard exists to prevent. */
  comments: ReviewComment[];
  onComments: (comments: ReviewComment[]) => void;
  /** Files already reviewed, held by the App for the same reason: the
      viewed marks are the reviewer's progress through a large diff, and
      ⌘I must not reset a review half walked. */
  viewed: string[];
  onViewed: (files: string[]) => void;
  onClose: () => void;
  /** The attempt ended: nothing is left to inspect here. */
  onDone: () => void;
  /** The merge landed — the one outcome worth saying out loud. */
  onMerged?: (branch: string) => void;
  /** Start one of the repo's run scripts in this attempt's worktree. */
  onRunScript: (name: string) => void;
  /** A shell of your own in this attempt's worktree. */
  onOpenShell: () => void;
  /** Park this attempt: ground given back, work and conversation kept. */
  onPark: () => void;
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
/** The drawer's width, remembered. Bounds keep both neighbours honest: a
 *  diff needs room to be code, and the terminal beside it needs room to
 *  stay a terminal. */
const WIDTH_KEY = 'agentdesk.inspectorWidth';
const clampWidth = (w: number) => Math.max(340, Math.min(900, w));

function storedWidth(): number {
  const w = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(w) && w > 0 ? clampWidth(w) : 460;
}

export function AttemptInspector({
  attempt,
  session,
  baseBranch,
  comments,
  onComments,
  viewed,
  onViewed,
  onClose,
  onDone,
  onMerged,
  onRunScript,
  onOpenShell,
  onPark,
}: Props) {
  const t = useT();
  const [width, setWidth] = useState(storedWidth);

  /** Drag the left edge; the pane grid beside it refits as it goes. The
   *  pointer is captured so a fast drag cannot escape a 6px handle. */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const startW = width;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(clampWidth(startW + (startX - ev.clientX)));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };

  /** role="separator" promises keyboard adjustability; the promise is
   *  kept — ← widens the drawer, → gives the space back. */
  const onGripKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = clampWidth(width + (e.key === 'ArrowLeft' ? 24 : -24));
    setWidth(next);
    localStorage.setItem(WIDTH_KEY, String(next));
  };
  const [pane, setPane] = useState<Pane>('diff');
  const [diff, setDiff] = useState<string | null>(null);
  /** When the diff on screen was read. The worktree keeps moving while you
      read — refresh is deliberate, so the staleness has to be visible. */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [events, setEvents] = useState<AttemptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The timeline's own failure, kept apart from the diff's: a fetch error
      rendered as "no activity yet" would be a lie on exactly the surface
      that audits what an agent did. */
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [stat, setStat] = useState<AttemptStat | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [runScripts, setRunScripts] = useState<string[]>([]);
  /** The manual checkpoint's answer, worn briefly by its own button —
      "kept #3" or "nothing new" is the whole story, and a toast for it
      would outlive the interest. */
  const [ckptSay, setCkptSay] = useState<string | null>(null);
  const [ckptBusy, setCkptBusy] = useState(false);
  useEffect(() => {
    if (ckptSay === null) return;
    const timer = setTimeout(() => setCkptSay(null), 4000);
    return () => clearTimeout(timer);
  }, [ckptSay]);
  /** The attempt's checkpoints, for the timeline's ↩ anchors. */
  const [cps, setCps] = useState<Checkpoint[]>([]);
  /** What the last restore did (or refused), shown over the timeline until
      dismissed — it names the retreat that was kept, which outlives 4s. */
  const [restored, setRestored] = useState<string | null>(null);
  /** What the diff is measured against: 0 for the attempt's base — the
      whole story — or a checkpoint's n for "what happened since". */
  const [compareTo, setCompareTo] = useState(0);

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
    setEventsError(null);
    void api
      .attemptDiff(attempt.id, compareTo || undefined)
      .then((d) => {
        setDiff(d);
        setFetchedAt(Date.now());
      })
      .catch((e) => setError(String(e)));
    void api
      .attemptEvents(attempt.id)
      .then(setEvents)
      .catch((e) => {
        // The diff half is still worth showing; the timeline says what
        // actually went wrong instead of pleading empty.
        setEventsError(String(e));
      });
    // Where the branch stands against its base. Only an open attempt has a
    // worktree to measure; a refusal here (worktree mid-teardown, base
    // branch renamed) costs a badge, not the drawer.
    if (attempt.outcome === null) {
      void api
        .attemptStats(attempt.id)
        .then(setStat)
        .catch(() => setStat(null));
      // The refs behind the timeline's ↩ anchors. A finished attempt has
      // none by design — the frozen diff is its record.
      void api
        .listCheckpoints(attempt.id)
        .then(setCps)
        .catch(() => setCps([]));
    } else {
      setStat(null);
      setCps([]);
    }
  }, [attempt.id, attempt.outcome, compareTo]);

  // Read on open and whenever the attempt changes. Not on a timer: a diff
  // that reflows under you while you are reading it is worse than one you
  // asked to refresh.
  useEffect(refresh, [refresh]);

  // The line being commented on is transient; the batch is not. Comments
  // live with the App keyed per attempt, so switching attempts shows each
  // one its own batch rather than wiping anything.
  useEffect(() => {
    setPicked(null);
    setRestored(null);
    setCompareTo(0);
  }, [attempt.id]);

  const parked = typeof attempt.parked_at === 'number';
  /** A turn in flight blocks restoring — the agent would keep believing in
      work that is no longer there — and so does parked: there is no ground
      to restore onto. The buttons stay, disabled, wearing the right reason
      — the merge-refusal pattern, ahead of the click. */
  const midTurn =
    session !== null &&
    session.live &&
    session.status !== 'idle' &&
    session.status !== 'saved' &&
    session.status !== 'exited';
  const restoreBlocked = parked ? t('park.restoreParked') : midTurn ? t('ckpt.blocked') : null;

  const doRestore = (n: number) => {
    void api
      .restoreCheckpoint(attempt.id, n)
      .then(() => {
        setRestored(n === 0 ? t('ckpt.restoredBase') : t('ckpt.restored', { n }));
        refresh();
      })
      .catch((e) => setRestored(String(e)));
  };

  return (
    <aside className="inspector" style={{ width }} data-testid="inspector">
      <div
        className="inspector-grip"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        data-testid="inspector-grip"
        title={t('inspector.resize')}
        aria-label={t('inspector.resize')}
        onPointerDown={onGripDown}
        onKeyDown={onGripKeys}
      />
      <header className="inspector-head">
        <div
          className="view-toggle"
          role="tablist"
          // The same contract the topbar keeps: one tab stop, arrows move.
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const next = pane === 'diff' ? 'timeline' : 'diff';
            setPane(next);
            (
              e.currentTarget.children[next === 'diff' ? 0 : 1] as HTMLElement
            )?.focus();
          }}
        >
          <button
            role="tab"
            aria-selected={pane === 'diff'}
            tabIndex={pane === 'diff' ? 0 : -1}
            className={pane === 'diff' ? 'active' : ''}
            data-testid="inspector-diff-tab"
            onClick={() => setPane('diff')}
          >
            {t('inspector.changes')}
          </button>
          <button
            role="tab"
            aria-selected={pane === 'timeline'}
            tabIndex={pane === 'timeline' ? 0 : -1}
            className={pane === 'timeline' ? 'active' : ''}
            data-testid="inspector-timeline-tab"
            onClick={() => setPane('timeline')}
          >
            {t('inspector.activity')}
          </button>
        </div>
        <span className="spacer" />
        <button className="icon" onClick={refresh} title={t('inspector.reload')} aria-label={t('inspector.reload')}>
          <Icon name="reload" />
        </button>
        <button className="icon" onClick={onClose} title={t('common.close')} aria-label={t('inspector.closeView')}>
          ✕
        </button>
      </header>

      <div className="inspector-meta mono small muted">
        <span>{attempt.branch}</span>
        <span title={attempt.base_sha}>base {attempt.base_sha.slice(0, 8)}</span>
        {/* Where the branch stands against its base — ↓ is the one that
            matters, because it is the merge refusal you have not hit yet. */}
        {stat && stat.ahead > 0 && (
          <span title={t('stats.ahead', { n: stat.ahead, branch: baseBranch })}>↑{stat.ahead}</span>
        )}
        {stat && stat.behind > 0 && (
          <span
            className="stat-behind"
            data-testid="inspector-behind"
            title={t('stats.behind', { n: stat.behind, branch: baseBranch })}
          >
            ↓{stat.behind}
          </span>
        )}
        {attempt.mode !== 'normal' && (
          <span className={`mode-badge ${attempt.mode}`}>
            <Icon name={attempt.mode === 'yolo' ? 'bolt' : 'pencil'} />{' '}
            {t(attempt.mode === 'yolo' ? 'mode.yolo' : 'mode.accept_edits')}
          </span>
        )}
        {attempt.outcome && (
          <span className="inspector-frozen" title={t('inspector.frozenHint')}>
            {t('inspector.frozen')}
          </span>
        )}
      </div>

      {/* The worktree's own terminals: a shell of yours, always — reviewing
          keeps demanding ad-hoc commands in *its* worktree, not yours — and
          the repo's ▶ scripts when it declares any. */}
      {attempt.outcome === null && !parked && (
        <div className="inspector-run" data-testid="run-scripts">
          <button
            className="chip mono"
            data-testid="open-shell"
            title={t('inspector.shellHint')}
            onClick={onOpenShell}
          >
            $ {t('inspector.shell')}
          </button>
          {runScripts.map((name) => (
            <button
              key={name}
              className="chip mono"
              data-testid={`run-${name}`}
              title={t('inspector.runHint', { name })}
              onClick={() => onRunScript(name)}
            >
              <Icon name="play" /> {name}
            </button>
          ))}
          {/* The manual snapshot — every agent's checkpoint, where Stop
              only covers claude. The button answers on itself. */}
          <button
            className="chip mono"
            data-testid="checkpoint-now"
            title={t('inspector.ckptHint')}
            disabled={ckptBusy}
            onClick={() => {
              setCkptBusy(true);
              void api
                .checkpointNow(attempt.id)
                .then((cp) =>
                  setCkptSay(
                    cp ? t('inspector.ckptMade', { n: cp.n }) : t('inspector.ckptNone'),
                  ),
                )
                .catch((e) => setCkptSay(String(e)))
                .finally(() => setCkptBusy(false));
            }}
          >
            {ckptSay ?? (
              <>
                <Icon name="flag" /> {t('inspector.ckpt')}
              </>
            )}
          </button>
          {/* Park, offered exactly when restore is: a settled worktree.
              Single click — the reversible act needs no arming. */}
          {!midTurn && (
            <button
              className="chip mono"
              data-testid="park-attempt"
              title={t('board.parkHint')}
              onClick={onPark}
            >
              ⏸ {t('board.park')}
            </button>
          )}
        </div>
      )}

      {/* A message is holding for the end of this turn. Visible where it
          was queued, with the one act that still applies: changing your
          mind before Stop spends it. */}
      {session?.has_followup && (
        <p className="queued-banner" data-testid="queued-followup">
          <span>{t('inspector.queued')}</span>
          <button
            className="chip"
            data-testid="cancel-followup"
            onClick={() =>
              void api.cancelFollowup(session.id).catch(() => {
                /* the next broadcast says what actually stuck */
              })
            }
          >
            {t('inspector.cancelQueued')}
          </button>
        </p>
      )}

      {error && (
        <p className="dialog-error" role="alert" data-testid="inspector-error">
          {error}
        </p>
      )}

      {pane === 'diff' ? (
        <>
          {/* Swap the baseline: the whole attempt, or what has happened
              since a checkpoint. Only offered once there is a checkpoint to
              compare against — a select with one honest option is furniture. */}
          {attempt.outcome === null && cps.length > 0 && (
            <div className="compare-row mono small">
              <label className="muted" htmlFor="ckpt-compare">
                {t('ckpt.compare')}
              </label>
              <select
                id="ckpt-compare"
                data-testid="ckpt-compare"
                value={compareTo}
                onChange={(e) => setCompareTo(Number(e.target.value) || 0)}
              >
                <option value={0}>{t('ckpt.compareBase')}</option>
                {cps.map((c) => (
                  <option key={c.n} value={c.n}>
                    {t('ckpt.compareN', { n: c.n, time: clock(c.at * 1000) })}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Keyed by attempt and baseline: the fold state describes one
              diff's files, and a different comparison is a different diff. */}
          <DiffPane
            key={`${attempt.id}@${compareTo}`}
            diff={diff}
            fetchedAt={fetchedAt}
            comments={comments}
            viewed={viewed}
            onViewed={onViewed}
            onPick={setPicked}
          />
        </>
      ) : (
        <>
          {restored !== null && (
            <p className="restore-banner small" data-testid="restore-say" aria-live="polite">
              <span>{restored}</span>
              {/* The pre-composed note, sent only by a human hand: the
                  worktree moved under the agent's feet, and claude can be
                  told through the same paste a follow-up rides. */}
              {session?.live === true && session.agent === 'claude' && (
                <button
                  className="chip"
                  data-testid="restore-tell"
                  onClick={() => {
                    void api.sendFollowup(session.id, t('ckpt.note')).catch(() => {
                      /* the terminal shows what actually arrived */
                    });
                    setRestored(null);
                  }}
                >
                  {t('ckpt.tell')}
                </button>
              )}
              <button
                className="chip"
                aria-label={t('common.close')}
                onClick={() => setRestored(null)}
              >
                ✕
              </button>
            </p>
          )}
          <Timeline
            events={events}
            error={eventsError}
            checkpoints={cps}
            onRestore={attempt.outcome === null ? doRestore : null}
            blocked={restoreBlocked}
          />
        </>
      )}

      {pane === 'diff' && (picked !== null || comments.length > 0) && (
        <Review
          attempt={attempt}
          session={session}
          picked={picked}
          comments={comments}
          onPick={setPicked}
          onChange={onComments}
          onSent={refresh}
          onProblem={setError}
        />
      )}

      {attempt.outcome === null && (
        <Finish
          attempt={attempt}
          baseBranch={baseBranch}
          next={stat ? nextAction(stat) : null}
          behind={stat?.behind ?? 0}
          onDone={onDone}
          onMerged={onMerged}
        />
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
  session,
  picked,
  comments,
  onPick,
  onChange,
  onSent,
  onProblem,
}: {
  attempt: Attempt;
  session: SessionMeta | null;
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

  /** Mid-turn, the batch queues instead of steering: sent now it would
   *  land inside the turn under review; held for Stop it arrives as the
   *  next one, about a diff that has stopped moving. */
  const midTurn = session?.status === 'running';

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
    const text = composeReview(comments, t);
    const deliver = midTurn
      ? api.queueFollowup(attempt.session_id, text)
      : api.sendFollowup(attempt.session_id, text);
    void deliver
      .then(() => {
        onChange([]);
        onPick(null);
        // The timeline now carries what was just asked — or, queued, the
        // banner above says what is waiting to be.
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
                {t(midTurn ? 'review.queue' : 'review.send', { count: comments.length })}
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
  next,
  behind,
  onDone,
  onMerged,
}: {
  attempt: Attempt;
  baseBranch: string;
  /** The merge path's own checks, run ahead of the click — what would
      refuse (uncommitted work), what would risk (a base that moved), or
      that the way is clear. */
  next: NextAction;
  behind: number;
  onDone: () => void;
  onMerged?: (branch: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = (what: string, fn: () => Promise<unknown>) => () => {
    setBusy(what);
    setProblem(null);
    void fn()
      .then((r) => {
        if (what === 'pr' && typeof r === 'string') setPrUrl(r);
        if (what === 'merge') onMerged?.(baseBranch);
        if (what === 'merge' || what === 'discard') onDone();
      })
      // Every refusal here is one that would otherwise lose work quietly —
      // uncommitted changes, the wrong branch checked out — so it is shown
      // in full rather than summarised.
      .catch((e) => setProblem(String(e)))
      .finally(() => setBusy(null));
  };

  /* Friction proportional to consequence: merge mutates the base branch —
     the one thing every hint promises an attempt cannot touch — so it arms
     exactly like discard does. Both name what the second click will do. */
  const merge = useArmed(run('merge', () => api.mergeAttempt(attempt.id)));
  const discard = useArmed(run('discard', () => api.finishAttempt(attempt.id, 'discarded')));

  return (
    <footer className="inspector-foot">
      {/* The refusal before the click: the same checks merge runs, worn as
          a banner while there is still time to act on them. */}
      {next !== null && (
        <p className={`next-banner ${next}`} data-testid="next-banner">
          {t(NEXT_KEY[next], { branch: baseBranch, n: behind })}
        </p>
      )}
      {problem && <FriendlyError text={problem} testid="finish-error" />}
      {/* The PR is the whole product of this path; its URL cannot be dead
          text in a 460px drawer. A real link that opens the browser, and a
          copy for wherever the review conversation actually happens. */}
      {prUrl && (
        <p className="mono small pr-url" data-testid="pr-url">
          <a
            href={prUrl}
            onClick={(e) => {
              e.preventDefault();
              void api.openExternal(prUrl);
            }}
          >
            {prUrl}
          </a>
          <button
            className="chip"
            data-testid="pr-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(prUrl);
              setCopied(true);
            }}
          >
            {copied ? t('attempt.copied') : t('inspector.copyUrl')}
          </button>
        </p>
      )}
      <div className="row">
        <button
          className={merge.armed ? 'confirm-arm' : 'primary'}
          disabled={busy !== null}
          data-testid={merge.armed ? 'confirm-merge' : 'merge-attempt'}
          onClick={merge.fire}
        >
          {busy === 'merge'
            ? t('inspector.working')
            : merge.armed
              ? t('inspector.confirmMerge', { branch: baseBranch })
              : t('inspector.mergeInto', { branch: baseBranch })}
        </button>
        <button
          disabled={busy !== null}
          data-testid="open-pr"
          onClick={run('pr', () => api.openPr(attempt.id))}
        >
          {busy === 'pr' ? t('inspector.working') : t('inspector.openPr')}
        </button>
        <span className="spacer" />
        <button
          className={discard.armed ? 'confirm-delete' : 'danger'}
          disabled={busy !== null}
          data-testid={discard.armed ? 'confirm-discard' : 'discard-attempt'}
          title={t('inspector.discardHint')}
          onClick={discard.fire}
        >
          {discard.armed ? t('inspector.confirmDiscard') : t('inspector.discard')}
        </button>
      </div>
    </footer>
  );
}

/** One file's slice of the diff: its lines, its counts, and the raw header
 *  lines the display no longer spends four rows of a 460px drawer on. */
interface FileSection {
  file: string | null;
  meta: string[];
  lines: { l: DiffLine; i: number }[];
  adds: number;
  dels: number;
}

/** The header lines every diff viewer folds away. Only what is recognized
 *  is folded — unrecognized text outside a hunk stays on screen, because a
 *  quietly hidden line is worse than an ugly one. */
const PLUMBING =
  /^(diff |index |--- |\+\+\+ |old mode|new mode|deleted file|new file|similarity |rename |copy |\\)/;

function groupByFile(lines: DiffLine[]): FileSection[] {
  const out: FileSection[] = [];
  let cur: FileSection | null = null;
  lines.forEach((l, i) => {
    if (l.kind === 'meta' && (PLUMBING.test(l.text) || l.text.trim() === '')) {
      if (l.text.startsWith('diff ') || cur === null) {
        cur = { file: null, meta: [], lines: [], adds: 0, dels: 0 };
        out.push(cur);
      }
      if (l.text.trim() !== '') cur.meta.push(l.text);
      return;
    }
    if (cur === null) {
      cur = { file: null, meta: [], lines: [], adds: 0, dels: 0 };
      out.push(cur);
    }
    cur.file ??= l.file;
    if (l.kind === 'add') cur.adds += 1;
    if (l.kind === 'del') cur.dels += 1;
    cur.lines.push({ l, i });
  });
  return out.filter((s) => s.lines.length > 0);
}

/** Wrapping long lines is a reading preference, not a per-diff choice. */
const WRAP_KEY = 'agentdesk.diffWrap';

function DiffPane({
  diff,
  fetchedAt,
  comments,
  viewed,
  onViewed,
  onPick,
}: {
  diff: string | null;
  fetchedAt: number | null;
  comments: readonly ReviewComment[];
  viewed: string[];
  onViewed: (files: string[]) => void;
  onPick: (p: Picked) => void;
}) {
  const t = useT();
  const lines = useMemo(() => (diff === null ? [] : parseDiff(diff)), [diff]);
  const sections = useMemo(() => groupByFile(lines), [lines]);

  /** Explicit opens and closes, per file, overriding the starting policy.
   *  The policy folds what nobody reads linearly — deletions, walls past
   *  800 lines, files already marked viewed — and a click reverses any of
   *  it; the click is remembered, the policy is not fought. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === '1');

  const fileKey = (s: FileSection, si: number) => s.file ?? `#${si}`;
  const isOpen = (s: FileSection, si: number) => {
    const explicit = open[fileKey(s, si)];
    if (explicit !== undefined) return explicit;
    return !(
      autoCollapse(s.lines.length, s.meta) ||
      (s.file !== null && viewed.includes(s.file))
    );
  };

  /** Marking viewed folds the file; unmarking reopens it. Either way the
   *  explicit override is cleared, so the policy speaks again. */
  const toggleViewed = (file: string) => {
    onViewed(
      viewed.includes(file) ? viewed.filter((f) => f !== file) : [...viewed, file],
    );
    setOpen((o) => {
      if (!(file in o)) return o;
      const next = { ...o };
      delete next[file];
      return next;
    });
  };

  if (diff === null) return <p className="muted small pad">{t('common.loading')}</p>;
  if (diff.trim() === '') {
    return (
      <p className="muted small pad" data-testid="diff-empty">
        {t('inspector.noChanges')}
      </p>
    );
  }

  const adds = sections.reduce((n, s) => n + s.adds, 0);
  const dels = sections.reduce((n, s) => n + s.dels, 0);

  const noted = (l: DiffLine) =>
    comments.some((c) => c.file === l.file && c.line === l.line && c.excerpt === l.text);

  /**
   * j/k walk the commentable lines, n/p the file headers; Enter acts on
   * whichever is focused — a comment on a line, a fold on a header.
   * Plain letters are safe here: the diff is not a text field, and the
   * review textarea lives outside this element, so typing never collides.
   */
  const onDiffKeys = (e: React.KeyboardEvent<HTMLPreElement>) => {
    const walk = (selector: string, forward: boolean) => {
      const stops = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
      if (stops.length === 0) return;
      e.preventDefault();
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next =
        at < 0
          ? stops[0]
          : stops[Math.min(stops.length - 1, Math.max(0, at + (forward ? 1 : -1)))];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'j' || e.key === 'k') {
      walk('.diff-line.commentable', e.key === 'j');
    } else if (e.key === 'n' || e.key === 'p') {
      walk('.diff-file-name', e.key === 'n');
    }
  };

  const seen = sections.filter((s) => s.file !== null && viewed.includes(s.file)).length;

  return (
    <>
      {/* The whole diff in one line, and when it was read. The reload sits
          in the header; this is the honesty that makes it worth pressing —
          a diff with no timestamp reads as current long after it is not. */}
      <div className="diff-summary mono small muted" data-testid="diff-summary">
        {/* The file count is also the jump: picking a file scrolls to it,
            reopening it if the fold policy had it away. */}
        <select
          className="diff-jump"
          value=""
          aria-label={t('inspector.jumpLabel')}
          data-testid="diff-jump"
          onChange={(e) => {
            const si = Number(e.target.value);
            if (!Number.isFinite(si) || !sections[si]) return;
            setOpen((o) => ({ ...o, [fileKey(sections[si], si)]: true }));
            // After the section has rendered open.
            requestAnimationFrame(() => {
              document
                .getElementById(`diff-file-${si}`)
                ?.scrollIntoView({ block: 'start' });
            });
          }}
        >
          <option value="" disabled>
            {t('inspector.diffSummary', { files: sections.length })}
          </option>
          {sections.map((s, si) => (
            <option key={si} value={si}>
              {s.file ?? '—'} +{s.adds} −{s.dels}
            </option>
          ))}
        </select>
        {adds > 0 && <span className="diff-count add">+{adds}</span>}
        {dels > 0 && <span className="diff-count del">−{dels}</span>}
        {seen > 0 && (
          <span data-testid="viewed-count">
            {t('inspector.viewedCount', { seen, files: sections.length })}
          </span>
        )}
        <span className="spacer" />
        <button
          className={`diff-wrap-toggle${wrap ? ' active' : ''}`}
          aria-pressed={wrap}
          data-testid="diff-wrap"
          title={t('inspector.wrap')}
          onClick={() => {
            setWrap(!wrap);
            localStorage.setItem(WRAP_KEY, wrap ? '0' : '1');
          }}
        >
          <Icon name="wrap" />
        </button>
        {fetchedAt !== null && (
          <span className="diff-fetched">{t('inspector.readAt', { time: clock(fetchedAt) })}</span>
        )}
      </div>
      <pre
        className={`diff mono${wrap ? ' wrap' : ''}`}
        data-testid="diff-body"
        tabIndex={0}
        onKeyDown={onDiffKeys}
      >
      {sections.map((s, si) => {
        const opened = isOpen(s, si);
        const isViewed = s.file !== null && viewed.includes(s.file);
        return (
        <span key={si} className="diff-section">
          {/* The plumbing (`index 1111111..`, `---/+++`) said nothing a
              reviewer acts on and cost four rows per file in a 460px
              drawer. The filename and its weight say it all; the raw
              header is a hover away. Roving focus like the lines: n/p
              land here, Enter folds. */}
          <span className="diff-file" id={`diff-file-${si}`}>
            <button
              className="diff-file-name"
              tabIndex={-1}
              aria-expanded={opened}
              title={s.meta.join('\n') || undefined}
              data-testid={`diff-fold-${si}`}
              onClick={() =>
                setOpen((o) => ({ ...o, [fileKey(s, si)]: !opened }))
              }
            >
              <span className="diff-caret" aria-hidden="true">
                {opened ? '▾' : '▸'}
              </span>
              {s.file ?? '—'}
            </button>
            {s.adds > 0 && <span className="diff-count add">+{s.adds}</span>}
            {s.dels > 0 && <span className="diff-count del">−{s.dels}</span>}
            <span className="spacer" />
            {s.file !== null && (
              <button
                className={`diff-viewed${isViewed ? ' on' : ''}`}
                tabIndex={-1}
                aria-pressed={isViewed}
                data-testid={`diff-viewed-${si}`}
                title={t(isViewed ? 'inspector.unmarkViewed' : 'inspector.markViewed')}
                onClick={() => toggleViewed(s.file as string)}
              >
                ✓
              </button>
            )}
          </span>
          {opened && s.lines.map(({ l, i }) => (
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
              // The review loop is the flagship; it cannot be mouse-only.
              // Roving focus: the <pre> is the single tab stop and j/k move
              // within it — per-line tabstops made a 300-line diff a
              // 300-stop wall between the header and the merge button.
              role={commentable(l) ? 'button' : undefined}
              tabIndex={commentable(l) ? -1 : undefined}
              onKeyDown={
                commentable(l)
                  ? (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        onPick({ file: l.file, line: l.line, excerpt: l.text });
                      }
                    }
                  : undefined
              }
              onClick={
                commentable(l)
                  ? () => onPick({ file: l.file, line: l.line, excerpt: l.text })
                  : undefined
              }
            >
              {/* Texture, not a parser's claim: strings and comments only,
                  tinted from whatever color the line already wears. The
                  runs concatenate back to l.text exactly — excerpts and
                  matching elsewhere compare against the raw line. */}
              {l.kind === 'add' || l.kind === 'del' || l.kind === 'context'
                ? tint(l.text).map((run, ri) =>
                    run.cls === null ? (
                      run.text
                    ) : (
                      <span key={ri} className={`tk-${run.cls}`}>
                        {run.text}
                      </span>
                    ),
                  )
                : l.text}
              {'\n'}
            </span>
          ))}
        </span>
        );
      })}
      </pre>
    </>
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

function Timeline({
  events,
  error,
  checkpoints,
  onRestore,
  blocked,
}: {
  events: AttemptEvent[];
  error: string | null;
  /** The attempt's snapshots, oldest first, for the ↩ anchors. */
  checkpoints: Checkpoint[];
  /** Null when the attempt is finished — nothing left to restore into. */
  onRestore: ((n: number) => void) | null;
  /** Why restoring is off the table right now (mid-turn, parked), or
      null when it is open. The buttons stay, disabled, wearing the reason. */
  blocked: string | null;
}) {
  const t = useT();
  const rows = useMemo(() => rollup(events), [events]);
  /** Which row's ↩ is armed — the two-click contract, one row at a time. */
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  /** "Before this turn" = the last snapshot taken before its prompt — or
      the attempt's base, the free zeroth checkpoint. */
  const targetOf = (promptAt: number): number => {
    let n = 0;
    for (const c of checkpoints) {
      if (c.at * 1000 <= promptAt) n = c.n;
    }
    return n;
  };
  // A failed read is not an empty history. "No activity yet" over a dead
  // fetch would clear an agent that was never audited.
  if (error !== null && events.length === 0) {
    return (
      <p className="dialog-error pad" role="alert" data-testid="timeline-error">
        {t('inspector.eventsFailed', { err: error })}
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="muted small pad" data-testid="timeline-empty">
        {t('inspector.noActivity')}
      </p>
    );
  }
  return (
    <ol className="timeline" data-testid="timeline">
      {rows.map((e, i) => (
        <li
          key={`${e.at}-${i}`}
          className={`tl-row tl-${e.kind}${e.tool === 'SendMessage' ? ' tl-send' : ''}`}
          data-kind={e.kind}
        >
          <span className="tl-time mono small muted">{clock(e.at)}</span>
          {e.kind === 'tool' ? (
            <>
              <span className="tl-tool mono">
                {/* A cross-session message is an act between cards, not a
                    tool grinding — it wears the arrow the README writes. */}
                {e.tool === 'SendMessage' && <span aria-hidden="true">→ </span>}
                {e.tool}
                {/* A run of the same tool is one act, not N lines between
                    the reader and the next real event. Every detail rides
                    the tooltip; the row shows the latest. */}
                {e.count > 1 && <span className="tl-count">×{e.count}</span>}
              </span>
              <span
                className="tl-detail mono small muted"
                title={e.details.length > 1 ? e.details.join('\n') : (e.detail ?? undefined)}
              >
                {e.detail}
              </span>
            </>
          ) : e.kind === 'status' ? (
            <span className="tl-status">
              {STATUS_KEY[e.detail as never] ? t(STATUS_KEY[e.detail as never]) : e.detail}
              {/* What the wait cost — the number the record alone cannot
                  show, measured to whatever happened next. */}
              {e.heldMs !== null && e.heldMs >= 1000 && (
                <span className="tl-held muted">
                  {' '}
                  {t('timeline.waited', { for: elapsed(e.at, e.at + e.heldMs) })}
                </span>
              )}
            </span>
          ) : (
            <>
              <span className="tl-prompt">{e.detail}</span>
              {/* The retreat, anchored where the turn began. Disabled — not
                  hidden — while the agent is mid-turn, so the reason is a
                  hover away instead of the button being a mystery. */}
              {onRestore !== null && (
                <button
                  className={`tl-restore${armed === i ? ' armed' : ''}`}
                  data-testid={`restore-${i}`}
                  disabled={blocked !== null}
                  title={blocked ?? t('ckpt.restoreHint')}
                  onClick={() => {
                    if (armed === i) {
                      setArmed(null);
                      onRestore(targetOf(e.at));
                    } else {
                      setArmed(i);
                    }
                  }}
                >
                  {armed === i ? t('ckpt.restoreArm') : '↩'}
                </button>
              )}
            </>
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
