import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AttemptStat } from '../api';
import type { Attempt, AttemptEvent } from '../types';
import { useT } from '../i18n';
import { useArmed } from './armed';
import { FriendlyError } from './FriendlyError';
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
  /** The feedback batch in progress, held by the App keyed per attempt.
      The drawer unmounts on ⌘I and follows focus between panes — if the
      batch lived here, either act would destroy typed feedback, which is
      exactly the loss the dialogs' dirty-guard exists to prevent. */
  comments: ReviewComment[];
  onComments: (comments: ReviewComment[]) => void;
  onClose: () => void;
  /** The attempt ended: nothing is left to inspect here. */
  onDone: () => void;
  /** The merge landed — the one outcome worth saying out loud. */
  onMerged?: (branch: string) => void;
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
export function AttemptInspector({
  attempt,
  baseBranch,
  comments,
  onComments,
  onClose,
  onDone,
  onMerged,
  onRunScript,
}: Props) {
  const t = useT();
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
      .attemptDiff(attempt.id)
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
    } else {
      setStat(null);
    }
  }, [attempt.id, attempt.outcome]);

  // Read on open and whenever the attempt changes. Not on a timer: a diff
  // that reflows under you while you are reading it is worse than one you
  // asked to refresh.
  useEffect(refresh, [refresh]);

  // The line being commented on is transient; the batch is not. Comments
  // live with the App keyed per attempt, so switching attempts shows each
  // one its own batch rather than wiping anything.
  useEffect(() => {
    setPicked(null);
  }, [attempt.id]);

  return (
    <aside className="inspector" data-testid="inspector">
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
          ↻
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
            {attempt.mode === 'yolo' ? '⚡ ' : '✎ '}
            {t(attempt.mode === 'yolo' ? 'mode.yolo' : 'mode.accept_edits')}
          </span>
        )}
        {attempt.outcome && (
          <span className="inspector-frozen" title={t('inspector.frozenHint')}>
            {t('inspector.frozen')}
          </span>
        )}
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
        <DiffPane diff={diff} fetchedAt={fetchedAt} comments={comments} onPick={setPicked} />
      ) : (
        <Timeline events={events} error={eventsError} />
      )}

      {pane === 'diff' && (picked !== null || comments.length > 0) && (
        <Review
          attempt={attempt}
          picked={picked}
          comments={comments}
          onPick={setPicked}
          onChange={onComments}
          onSent={refresh}
          onProblem={setError}
        />
      )}

      {attempt.outcome === null && (
        <Finish attempt={attempt} baseBranch={baseBranch} onDone={onDone} onMerged={onMerged} />
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
  onMerged,
}: {
  attempt: Attempt;
  baseBranch: string;
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

function DiffPane({
  diff,
  fetchedAt,
  comments,
  onPick,
}: {
  diff: string | null;
  fetchedAt: number | null;
  comments: readonly ReviewComment[];
  onPick: (p: Picked) => void;
}) {
  const t = useT();
  const lines = useMemo(() => (diff === null ? [] : parseDiff(diff)), [diff]);
  const sections = useMemo(() => groupByFile(lines), [lines]);

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
   * j/k walk the commentable lines, Enter (per line) opens the comment.
   * Plain letters are safe here: the diff is not a text field, and the
   * review textarea lives outside this element, so typing never collides.
   */
  const onDiffKeys = (e: React.KeyboardEvent<HTMLPreElement>) => {
    if (e.key !== 'j' && e.key !== 'k') return;
    const lines = [...e.currentTarget.querySelectorAll<HTMLElement>('.diff-line.commentable')];
    if (lines.length === 0) return;
    e.preventDefault();
    const at = lines.indexOf(document.activeElement as HTMLElement);
    const next =
      at < 0
        ? lines[0]
        : lines[Math.min(lines.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      {/* The whole diff in one line, and when it was read. The reload sits
          in the header; this is the honesty that makes it worth pressing —
          a diff with no timestamp reads as current long after it is not. */}
      <div className="diff-summary mono small muted" data-testid="diff-summary">
        <span>
          {t('inspector.diffSummary', { files: sections.length })}
          {adds > 0 && <span className="diff-count add"> +{adds}</span>}
          {dels > 0 && <span className="diff-count del"> −{dels}</span>}
        </span>
        {fetchedAt !== null && (
          <span className="diff-fetched">{t('inspector.readAt', { time: clock(fetchedAt) })}</span>
        )}
      </div>
      <pre className="diff mono" data-testid="diff-body" tabIndex={0} onKeyDown={onDiffKeys}>
      {sections.map((s, si) => (
        <span key={si} className="diff-section">
          {/* The plumbing (`index 1111111..`, `---/+++`) said nothing a
              reviewer acts on and cost four rows per file in a 460px
              drawer. The filename and its weight say it all; the raw
              header is a hover away. */}
          <span className="diff-file" title={s.meta.join('\n') || undefined}>
            <span className="diff-file-name">{s.file ?? '—'}</span>
            {s.adds > 0 && <span className="diff-count add">+{s.adds}</span>}
            {s.dels > 0 && <span className="diff-count del">−{s.dels}</span>}
          </span>
          {s.lines.map(({ l, i }) => (
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
              {l.text}
              {'\n'}
            </span>
          ))}
        </span>
      ))}
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

function Timeline({ events, error }: { events: AttemptEvent[]; error: string | null }) {
  const t = useT();
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
      {events.map((e) => (
        <li key={e.id} className={`tl-row tl-${e.kind}`} data-kind={e.kind}>
          <span className="tl-time mono small muted">{clock(e.at)}</span>
          {e.kind === 'tool' ? (
            <>
              <span className="tl-tool mono">{e.tool}</span>
              {/* One truncated line in the list; the full command a hover away. */}
              <span className="tl-detail mono small muted" title={e.detail ?? undefined}>
                {e.detail}
              </span>
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
