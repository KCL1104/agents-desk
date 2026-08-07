import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Attempt, Lifecycle, SessionMeta, Task } from '../types';
import { needsYou } from '../types';
import {
  columnOf,
  COLUMN_LABEL,
  COLUMNS,
  dropIndex,
  liveLabel,
  liveStateOf,
  liveTone,
  STATUS_LABEL,
  TASK_MIME,
  type Live,
} from '../board';

interface Props {
  tasks: Task[];
  sessions: SessionMeta[];
  /** Go to this session's terminal, with the caret in it. */
  onOpenSession: (id: string) => void;
  onMove: (id: string, lifecycle: Lifecycle, position: number) => void;
  onStart: (task: Task) => void;
  onResume: (attemptId: string) => void;
  /** Open the diff and timeline for this attempt, beside its terminal. */
  onInspect: (attempt: Attempt) => void;
  onCancelQueued: (taskId: string) => void;
  onNewTask: () => void;
  onDeleteTask: (id: string) => void;
}

/**
 * The board.
 *
 * Two axes, kept apart on purpose. The column is where a person put the card;
 * the light is what the agent's session is reporting right now. Nothing the
 * agent reports moves a card — `Stop` means "this turn ended", not "the work
 * is done" — so the only thing that changes a column is a drag.
 *
 * What this buys, and what neither a board nor a row of terminal tabs can do
 * on its own: a card sitting in 進行中 lights up 「⚠ 等你授權」by itself, and
 * clicking it puts you in the live TUI with the caret already there.
 */
export function Board({
  tasks,
  sessions,
  onOpenSession,
  onMove,
  onStart,
  onResume,
  onInspect,
  onCancelQueued,
  onNewTask,
  onDeleteTask,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: Lifecycle; taskId: string | null } | null>(null);

  const adHoc = sessions.filter((s) => s.attempt_id === null);
  const running = sessions.filter((s) => s.live && s.attempt_id !== null).length;

  /**
   * Which card moved, and where it lands.
   *
   * The id comes off the drag itself rather than out of React state. State is
   * what `dragging` and the insertion marker are for — appearance — and a
   * render between `dragstart` and `drop` is not something a drop handler
   * should have to depend on having happened.
   */
  const drop = (e: React.DragEvent, col: Lifecycle, overId: string | null) => {
    const id = e.dataTransfer.getData(TASK_MIME) || dragId;
    setDragId(null);
    setOver(null);
    if (!id) return;
    onMove(id, col, dropIndex(columnOf(tasks, col), id, overId));
  };

  return (
    <div className="board" data-testid="board">
      <Concurrency running={running} tasks={tasks} />
      <div className="board-cols">
        {COLUMNS.map((col) => {
          const cards = columnOf(tasks, col);
          return (
            <section
              key={col}
              className={`board-col${over?.col === col ? ' drop-over' : ''}`}
              data-col={col}
              data-testid={`col-${col}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TASK_MIME)) return;
                e.preventDefault();
                setOver({ col, taskId: null });
              }}
              onDragLeave={(e) => {
                // Only when the pointer has actually left the column, not when
                // it crosses onto a card inside it.
                if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) {
                  setOver((o) => (o?.col === col ? null : o));
                }
              }}
              // The column's own space appends; a card handles its own drop
              // and inserts before itself.
              onDrop={(e) => {
                e.preventDefault();
                drop(e, col, null);
              }}
            >
              <h2 className="board-col-head">
                {COLUMN_LABEL[col]}
                <span className="section-count">{cards.length}</span>
                {col === 'backlog' && (
                  <button className="icon" onClick={onNewTask} title="新增卡片" aria-label="新增卡片">
                    ＋
                  </button>
                )}
              </h2>
              <div className="board-cards">
                {cards.map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    live={liveStateOf(task, sessions)}
                    dragging={dragId === task.id}
                    insertBefore={over?.col === col && over.taskId === task.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TASK_MIME, task.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(task.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(TASK_MIME)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setOver({ col, taskId: task.id });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      drop(e, col, task.id);
                    }}
                    onOpenSession={onOpenSession}
                    onStart={() => onStart(task)}
                    onResume={onResume}
                    onInspect={onInspect}
                    onCancelQueued={onCancelQueued}
                    onDelete={() => onDeleteTask(task.id)}
                  />
                ))}
                {cards.length === 0 && <p className="board-empty muted small">—</p>}
              </div>
            </section>
          );
        })}
      </div>

      {/* Not everything is worth a card. These sit outside the board on
          purpose: they have no worktree, no branch, and no lifecycle. */}
      <section className="board-adhoc" data-testid="adhoc">
        <h2 className="board-col-head">
          臨時 session
          <span className="section-count">{adHoc.length}</span>
        </h2>
        <div className="adhoc-row">
          {adHoc.map((s) => (
            <button
              key={s.id}
              className={`adhoc-chip${needsYou(s.status) ? ' needs-you' : ''}`}
              data-testid={`adhoc-${s.id}`}
              onClick={() => onOpenSession(s.id)}
            >
              <span className={`dot ${s.status}`} />
              <span className="adhoc-title">{s.title}</span>
              <span className="muted small">{STATUS_LABEL[s.status]}</span>
            </button>
          ))}
          {adHoc.length === 0 && <p className="muted small">沒有臨時 session。</p>}
        </div>
      </section>
    </div>
  );
}

/**
 * How many attempts may hold a terminal at once.
 *
 * The thing being rationed is a person, not a machine — this is an attention
 * scheduler, and past three or four live TUIs nobody is keeping a thread on
 * all of them. Cards over the limit wait and then go by themselves.
 */
function Concurrency({ running, tasks }: { running: number; tasks: Task[] }) {
  const [max, setMax] = useState<number | null>(null);
  const queued = tasks.filter((t) => t.queued_at !== null).length;

  // Re-read whenever the running count moves: raising the limit releases what
  // was waiting, and the number here should agree with the board.
  useEffect(() => {
    void api
      .concurrency()
      .then((c) => setMax(c.max))
      .catch(() => setMax(null));
  }, [running, queued]);

  const change = (next: number) => {
    setMax(next);
    void api.setConcurrency(next).catch(() => {
      /* the next read puts it back */
    });
  };

  if (max === null) return null;
  return (
    <div className="board-limit" data-testid="concurrency">
      <span className="muted small">同時執行</span>
      <button
        className="icon"
        disabled={max <= 1}
        aria-label="減少同時執行數"
        onClick={() => change(max - 1)}
      >
        −
      </button>
      <strong data-testid="concurrency-max">
        {running} / {max}
      </strong>
      <button className="icon" aria-label="增加同時執行數" onClick={() => change(max + 1)}>
        ＋
      </button>
      {queued > 0 && (
        <span className="muted small" data-testid="queue-count">
          · {queued} 個排隊中
        </span>
      )}
    </div>
  );
}

function Card({
  task,
  live,
  dragging,
  insertBefore,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpenSession,
  onStart,
  onResume,
  onInspect,
  onCancelQueued,
  onDelete,
}: {
  task: Task;
  live: Live;
  dragging: boolean;
  insertBefore: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpenSession: (id: string) => void;
  onStart: () => void;
  onResume: (attemptId: string) => void;
  onInspect: (attempt: Attempt) => void;
  onCancelQueued: (taskId: string) => void;
  onDelete: () => void;
}) {
  const waiting = live.kind === 'session' && needsYou(live.status);
  const hasAttempt = live.kind !== 'none' && live.kind !== 'queued';
  const agent = hasAttempt ? live.attempt.agent : null;

  // The whole card is the target when there is a session behind it: getting
  // into the TUI is the common act, and making people find a small button
  // for it would be the wrong thing to optimise.
  const enter = live.kind === 'session' ? () => onOpenSession(live.session.id) : undefined;

  return (
    <article
      className={[
        'board-card',
        waiting ? 'needs-you' : '',
        dragging ? 'dragging' : '',
        insertBefore ? 'insert-before' : '',
        enter ? 'enterable' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`task-${task.id}`}
      data-lifecycle={task.lifecycle}
      data-live={live.kind}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={enter}
    >
      <header className="board-card-head">
        <span className={`dot ${liveTone(live)}`} />
        <span className="board-card-title">{task.title}</span>
        {agent && <span className="ov-agent mono">{agent}</span>}
      </header>

      <div className="board-card-state" data-testid={`state-${task.id}`}>
        {waiting && <span aria-hidden="true">⚠ </span>}
        {liveLabel(live)}
        {hasAttempt && <span className="muted small mono"> #{live.attempt.seq}</span>}
      </div>

      {live.kind === 'session' && live.session.activity && (
        <div className="board-card-activity mono small muted">
          {live.session.activity.tool} {live.session.activity.detail}
        </div>
      )}

      <footer className="board-card-foot">
        {live.kind === 'none' && (
          <button className="primary" onClick={stop(onStart)}>
            開始
          </button>
        )}
        {/* Waiting for a slot. It will go on its own, so the only thing worth
            offering is a way to change your mind. */}
        {live.kind === 'queued' && (
          <button
            data-testid={`unqueue-${task.id}`}
            onClick={stop(() => onCancelQueued(task.id))}
          >
            取消排隊
          </button>
        )}
        {/* Every attempt is in this state after a restart — the app kills its
            PTYs on the way out — so resuming is a first-class button, not
            something to rediscover. It continues the agent's own history and
            does not send the prompt again. */}
        {live.kind === 'stopped' && (
          <button
            className="primary"
            data-testid={`resume-${task.id}`}
            onClick={stop(() => onResume(live.attempt.id))}
          >
            繼續
          </button>
        )}
        {/* Answers "what did this one change, and what did it do" without
            reading the TUI — which is the whole job of the 待驗收 column. */}
        {hasAttempt && (
          <button
            data-testid={`inspect-${task.id}`}
            onClick={stop(() => onInspect(live.attempt))}
          >
            檢視
          </button>
        )}
        {/* Another go at the same card, with a different agent. It leaves the
            attempt that is already there alone: two agents on one card, each
            in its own worktree, is a thing worth being able to do — comparing
            their diffs is the point. Deciding which one won is a separate,
            deliberate act, not a side effect of starting the second. */}
        {hasAttempt && (
          <button
            className={live.kind === 'finished' ? 'primary' : ''}
            data-testid={`retry-${task.id}`}
            onClick={stop(onStart)}
            title="用另一個 agent 再開一個 attempt"
          >
            {live.kind === 'finished' ? '再試一次' : '換 agent'}
          </button>
        )}
        <span className="spacer" />
        <button className="icon" onClick={stop(onDelete)} title="刪除卡片" aria-label="刪除卡片">
          ✕
        </button>
      </footer>
    </article>
  );
}

/** Buttons inside a card must not also trigger the card's own click. */
function stop(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}
