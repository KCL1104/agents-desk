import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { api, subscribe } from './api';
import type { BootStatus, Lifecycle, SessionMeta, Tab, Task } from './types';
import { BootGate } from './components/BootGate';
import { SessionList } from './components/SessionList';
import { EdgeDrop, EmptyGrid, Pane } from './components/Pane';
import { Splitter } from './components/Splitter';
import { Overview } from './components/Overview';
import { Board } from './components/Board';
import { TabStrip } from './components/TabStrip';
import { NewSessionDialog } from './components/NewSessionDialog';
import { NewTaskDialog, rememberRepo } from './components/NewTaskDialog';
import { StartAttemptDialog } from './components/StartAttemptDialog';
import { AttemptInspector } from './components/AttemptInspector';
import {
  addMember,
  autoCols,
  autoRows,
  dropOn,
  dropOnRoot,
  DRAG_MIME,
  formatLayout,
  geometry,
  gridStyle,
  isSplit,
  leaves,
  materialise,
  members as memberIds,
  nodeAt,
  parseLayout,
  reconcile,
  reconcileTree,
  removeLeaf,
  removeMember,
  resetFractions,
  sameIds,
  setFractions,
  type DragPayload,
  type Layout,
  type Node,
  type Zone,
} from './layout';
import { ColumnPicker } from './components/ColumnPicker';
import { EnvPanel } from './components/EnvPanel';
import { useSize } from './useSize';

/** Terminals start at a sane size; the pane refits within a frame of mounting. */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 32;

type View = 'terminal' | 'board' | 'overview';
const VIEW_KEY = 'agentdesk.view';
const TAB_KEY = 'agentdesk.activeTab';

/** Centre-drop within auto mode: the two trade places in the running order. */
function swapIds(ids: readonly string[], movingId: string, targetId: string): string[] {
  const ti = ids.indexOf(targetId);
  if (ti < 0) return [...ids];
  const mi = ids.indexOf(movingId);
  const next = ids.slice();
  next[ti] = movingId;
  // A session arriving from the sidebar has no slot to give back, so the pane
  // it landed on returns to the sidebar instead.
  if (mi >= 0) next[mi] = targetId;
  return next;
}

export default function App() {
  const [boot, setBoot] = useState<BootStatus | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    localStorage.getItem(TAB_KEY),
  );
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View) || 'terminal',
  );
  /** Focus and zoom key on the session, never on a position. A position is not
   *  an identity: rearranging would silently move them to another agent. */
  const [focused, setFocused] = useState<string | null>(null);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  /** Live tree while a splitter is being dragged; `undefined` when it is not. */
  const [liveRoot, setLiveRoot] = useState<Node | null | undefined>(undefined);
  /** Something is being dragged, so the layout's own edges become targets. */
  const [dragging, setDragging] = useState(false);
  /** A tab that was just created opens in rename mode; naming it is the whole
   *  point of having more than one. */
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showNewTask, setShowNewTask] = useState(false);
  /** The card whose start dialog is open. */
  const [starting, setStarting] = useState<Task | null>(null);
  /** Kept beside the dialog rather than in the toast: a rejected repository
   *  is something to correct in the form, not to be told about elsewhere. */
  const [dialogError, setDialogError] = useState<string | null>(null);
  /** Which attempt the diff/timeline drawer is showing, or null when it is
   *  closed. It sits *beside* the terminal, so answering what you just read is
   *  one keystroke rather than a navigation. Held as an id rather than
   *  derived from the focused session, because a finished attempt has no
   *  session left and is exactly the thing you most want to read. */
  const [inspectId, setInspectId] = useState<string | null>(null);

  const [gridRef, size] = useSize<HTMLDivElement>();

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void (async () => {
      setBoot(await api.bootStatus());
      dispose = await subscribe({
        onSessions: (list) => {
          setSessions(list);
          setLoaded(true);
        },
        onTabs: setTabs,
        onTasks: setTasks,
        onExit: () => {},
        onBadge: () => {},
        onCoreReady: () => void api.bootStatus().then(setBoot),
        onCoreFailed: (error) => setBoot({ ready: false, error }),
      });

      // Subscribe first, then read the current state. The core broadcasts
      // both lists as it starts, which is before this window can be
      // listening — without the read the app would sit empty until something
      // happened to change.
      const [initialTabs, initialSessions, initialTasks] = await Promise.all([
        api.listTabs().catch(() => []),
        api.listSessions().catch(() => []),
        api.listTasks().catch(() => []),
      ]);
      setTabs((cur) => (cur.length ? cur : initialTabs));
      setSessions((cur) => (cur.length ? cur : initialSessions));
      setTasks((cur) => (cur.length ? cur : initialTasks));
      setLoaded(true);
    })();
    return () => dispose?.();
  }, []);

  // The arrangement lives on the tab, so it survives a restart. Only which tab
  // you were last looking at is local.
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );
  const layout = useMemo(() => parseLayout(activeTab?.layout), [activeTab?.layout]);
  const members = useMemo(() => memberIds(activeTab?.slots), [activeTab?.slots]);

  useEffect(() => {
    if (activeTab) localStorage.setItem(TAB_KEY, activeTab.id);
    setZoomedId(null);
    setLiveRoot(undefined);
  }, [activeTab?.id]);

  const commit = useCallback(
    (nextLayout: Layout, nextMembers: string[]) => {
      if (!activeTab) return;
      // Members and the tree are two views of one thing, so every write
      // reconciles them rather than trusting them to have stayed in step.
      const final: Layout =
        nextLayout.mode === 'manual'
          ? { mode: 'manual', root: reconcileTree(nextLayout.root, nextMembers) }
          : nextLayout;
      void api
        .updateTab(activeTab.id, formatLayout(final), nextMembers)
        .catch((e) => setError(`更新分頁失敗：${String(e)}`));
    },
    [activeTab],
  );

  // A session that stopped running leaves the layout. Nothing is pulled in to
  // replace it: refilling a pane the user just ejected makes eject look
  // broken, and that is a bug this app has already had once.
  useEffect(() => {
    if (!activeTab || !loaded) return;
    const next = reconcile(members, sessions);
    if (!sameIds(next, members)) commit(layout, next);
  }, [sessions, members, layout, activeTab, loaded, commit]);

  /* ---------------------------- geometry ---------------------------- */

  const cols = autoCols(layout, size.w, members.length);
  const rows = autoRows(members.length, cols);

  const root = useMemo(
    () => (layout.mode === 'manual' ? reconcileTree(layout.root, members) : null),
    [layout, members],
  );
  const shownRoot = liveRoot !== undefined ? liveRoot : root;

  const geom = useMemo(
    () =>
      layout.mode === 'manual'
        ? geometry(shownRoot, { x: 0, y: 0, w: size.w, h: size.h })
        : null,
    [layout.mode, shownRoot, size.w, size.h],
  );

  const focusedId = focused && members.includes(focused) ? focused : (members[0] ?? null);
  const zoomed = zoomedId && members.includes(zoomedId) ? zoomedId : null;

  const active = useMemo(
    () => sessions.find((s) => s.id === focusedId) ?? null,
    [sessions, focusedId],
  );

  const attempts = useMemo(() => tasks.flatMap((t) => t.attempts), [tasks]);

  /** The attempt behind the focused session, if it has one. */
  const activeAttemptId = active?.attempt_id ?? null;

  const inspected = useMemo(
    () => attempts.find((a) => a.id === inspectId) ?? null,
    [attempts, inspectId],
  );

  // With the drawer open, moving to another session's pane moves the drawer
  // with it. Reading one attempt's diff while looking at another's terminal
  // is the one arrangement that could actively mislead.
  useEffect(() => {
    if (!inspectId || !activeAttemptId) return;
    if (activeAttemptId !== inspectId) setInspectId(activeAttemptId);
  }, [activeAttemptId, inspectId]);

  // Every live session keeps a mounted terminal, whichever tab or view is
  // showing, so switching never costs a repaint or loses scrollback.
  const liveIds = useMemo(() => sessions.filter((s) => s.live).map((s) => s.id), [sessions]);

  /* ----------------------------- actions ---------------------------- */

  const onCreate = useCallback(
    async (cwd: string, agent: string, args: string[]) => {
      setShowNew(false);
      setError(null);
      try {
        const id = await api.newSession(cwd, agent, args, INITIAL_COLS, INITIAL_ROWS);
        commit(layout, addMember(members, id));
        setFocused(id);
        setView('terminal');
      } catch (e) {
        // Without this the dialog just closes and nothing happens, which reads
        // as a dead button rather than a failure.
        setError(`開啟 session 失敗：${String(e)}`);
      }
    },
    [commit, layout, members],
  );

  /** Clicking a sidebar row adds it to the layout; dragging places it. */
  const onSelect = useCallback(
    async (id: string) => {
      commit(layout, addMember(members, id));
      setFocused(id);
      const s = sessions.find((x) => x.id === id);
      // Reopening a saved session reattaches a terminal, continuing the
      // agent's own conversation history in that directory.
      if (s && !s.live) {
        try {
          await api.reopenSession(id, INITIAL_COLS, INITIAL_ROWS);
        } catch (e) {
          setError(`重新開啟失敗：${String(e)}`);
        }
      }
    },
    [sessions, commit, layout, members],
  );

  /**
   * A pane or a sidebar row was dropped on the pane showing `targetId`.
   *
   * Dropping on an edge is what turns a row of four into a 2x2, and it is the
   * moment a tab stops being auto: the arrangement is now something the user
   * built rather than something the window width implied.
   */
  const onDropOnPane = useCallback(
    (targetId: string, payload: DragPayload, zone: Zone) => {
      if (payload.id === targetId) return;

      if (layout.mode === 'auto' && zone === 'center') {
        commit(layout, swapIds(members, payload.id, targetId));
        setFocused(payload.id);
        return;
      }

      const base = layout.mode === 'manual' ? root : materialise(members, cols);
      const next = dropOn(base, payload.id, targetId, zone);
      commit({ mode: 'manual', root: next }, leaves(next));
      setFocused(payload.id);
    },
    [commit, layout, members, root, cols],
  );

  const onEject = useCallback(
    (id: string) => {
      if (layout.mode === 'manual') {
        const next = removeLeaf(root, id);
        commit({ mode: 'manual', root: next }, leaves(next));
      } else {
        commit(layout, removeMember(members, id));
      }
    },
    [commit, layout, members, root],
  );

  /** Dropped on the grid itself rather than on a pane: put it at the end. */
  const onDropOnGrid = useCallback(
    (payload: DragPayload) => {
      commit(layout, addMember(members, payload.id));
      setFocused(payload.id);
    },
    [commit, layout, members],
  );

  /** Dropped on the layout's outer edge: it spans that whole side. */
  const onDropOnEdge = useCallback(
    (payload: DragPayload, zone: Zone) => {
      const base = layout.mode === 'manual' ? root : materialise(members, cols);
      const next = dropOnRoot(base, payload.id, zone);
      commit({ mode: 'manual', root: next }, leaves(next));
      setFocused(payload.id);
    },
    [commit, layout, members, root, cols],
  );

  const onPickCols = useCallback(
    (value: 'auto' | number) => {
      setZoomedId(null);
      commit({ mode: 'auto', cols: value }, members);
    },
    [commit, members],
  );

  /** From the overview or the board: focus a session and go look at it. */
  const onOpen = useCallback(
    async (id: string) => {
      await onSelect(id);
      setView('terminal');
    },
    [onSelect],
  );

  /* ------------------------------ board ----------------------------- */

  const onCreateTask = useCallback(
    async (title: string, prompt: string, repoPath: string, baseBranch: string) => {
      setDialogError(null);
      try {
        await api.createTask(title, prompt, repoPath, baseBranch);
        rememberRepo(repoPath);
        setShowNewTask(false);
      } catch (e) {
        // The core refuses a repository that is not one, or a base branch
        // that does not exist. Both are things to fix in this form.
        setDialogError(String(e));
      }
    },
    [],
  );

  /**
   * Start an attempt, then go straight into its terminal.
   *
   * Landing in the TUI is the point: the first thing a new worktree does is
   * ask whether you trust the folder, and the answer is one keystroke away
   * only if you are already looking at it.
   */
  const onStartAttempt = useCallback(
    async (task: Task, agent: string, prompt: string) => {
      setDialogError(null);
      try {
        const opened = await api.openAttempt(
          task.id,
          agent,
          prompt,
          INITIAL_COLS,
          INITIAL_ROWS,
        );
        setStarting(null);
        await onOpen(opened.session_id);
      } catch (e) {
        setDialogError(String(e));
      }
    },
    [onOpen],
  );

  /** Put a terminal back on an attempt — the state every attempt is in after
   *  a restart, so this has to land you in the TUI just like starting does. */
  const onResumeAttempt = useCallback(
    async (attemptId: string) => {
      try {
        const sessionId = await api.reopenAttempt(attemptId, INITIAL_COLS, INITIAL_ROWS);
        await onOpen(sessionId);
      } catch (e) {
        setError(`繼續 attempt 失敗：${String(e)}`);
      }
    },
    [onOpen],
  );

  /**
   * Review an attempt: open the drawer, and put its terminal up beside it.
   *
   * Both, not either. The diff answers what changed; the terminal is where
   * you say what is still wrong. A finished attempt has no session left, so
   * that half is simply absent rather than broken.
   */
  const onInspectAttempt = useCallback(
    async (attempt: { id: string; session_id: string | null }) => {
      setInspectId(attempt.id);
      if (attempt.session_id) await onOpen(attempt.session_id);
      else setView('terminal');
    },
    [onOpen],
  );

  const onMoveTask = useCallback((id: string, lifecycle: Lifecycle, position: number) => {
    void api.moveTask(id, lifecycle, position).catch((e) => setError(`搬移卡片失敗：${String(e)}`));
  }, []);

  const onDeleteTask = useCallback((id: string) => {
    void api.deleteTask(id).catch((e) => setError(`刪除卡片失敗：${String(e)}`));
  }, []);

  if (!boot?.ready) {
    return <BootGate boot={boot} onRetry={() => void api.bootStatus().then(setBoot)} />;
  }

  const manual = layout.mode === 'manual';

  return (
    <div
      className="app"
      // Bubble phase, not capture: the source sets the payload in its own
      // handler, so during capture `types` is still empty.
      onDragStart={(e) => setDragging(e.dataTransfer.types.includes(DRAG_MIME))}
      onDragEnd={() => setDragging(false)}
      onDrop={() => setDragging(false)}
    >
      <SessionList
        sessions={sessions}
        activeId={focusedId}
        onSelect={onSelect}
        onNew={() => setShowNew(true)}
        onClose={(id) => void api.closeSession(id)}
        onArchive={(id) => void api.archiveSession(id)}
        onComplete={(id, completed) => void api.setCompleted(id, completed)}
        onShowEnv={() => setShowEnv(true)}
      />

      <main className="main">
        <TabStrip
          tabs={tabs}
          activeId={activeTab?.id ?? null}
          sessions={sessions}
          onSelect={setActiveTabId}
          renameId={renameTabId}
          onCreate={() =>
            void api
              .createTab(`工作 ${tabs.length + 1}`)
              .then((id) => {
                setActiveTabId(id);
                setRenameTabId(id);
              })
              .catch((e) => setError(`新增分頁失敗：${String(e)}`))
          }
          onRename={(id, name) => {
            setRenameTabId(null);
            void api.renameTab(id, name);
          }}
          onClose={(id) => void api.closeTab(id).catch((e) => setError(String(e)))}
        />

        <header className="topbar">
          {view === 'terminal' && active ? (
            <>
              <span className={`dot ${active.status}`} />
              <strong>{active.title}</strong>
              <span className="muted mono">{active.cwd}</span>
            </>
          ) : (
            <strong>
              {view === 'overview' ? '總覽' : view === 'board' ? '看板' : '尚無 session'}
            </strong>
          )}
          <span className="spacer" />
          {view === 'terminal' && (activeAttemptId || inspected) && (
            <button
              className={inspectId ? 'active' : ''}
              data-testid="toggle-inspector"
              aria-pressed={inspectId !== null}
              onClick={() => setInspectId(inspectId ? null : activeAttemptId)}
            >
              變更／活動
            </button>
          )}
          {view === 'terminal' && <ColumnPicker layout={layout} onPick={onPickCols} />}
          <div className="view-toggle" role="tablist">
            <button
              role="tab"
              aria-selected={view === 'terminal'}
              className={view === 'terminal' ? 'active' : ''}
              onClick={() => setView('terminal')}
            >
              終端機
            </button>
            <button
              role="tab"
              aria-selected={view === 'board'}
              className={view === 'board' ? 'active' : ''}
              data-testid="view-board"
              onClick={() => setView('board')}
            >
              看板
            </button>
            <button
              role="tab"
              aria-selected={view === 'overview'}
              className={view === 'overview' ? 'active' : ''}
              onClick={() => setView('overview')}
            >
              總覽
            </button>
          </div>
        </header>

        {/* Both views stay mounted: unmounting the terminals would dispose
            their scrollback and force every TUI to repaint on return. */}
        <div className="term-area" style={{ display: view === 'terminal' ? 'flex' : 'none' }}>
        <div
          className="term-stack"
          ref={gridRef}
          data-mode={manual ? 'manual' : 'auto'}
          data-cols={manual ? undefined : cols}
        >
          <div
            className={`term-grid${manual ? ' manual' : ''}`}
            style={
              manual || zoomed
                ? undefined
                : { display: 'grid', ...gridStyle(cols, rows) }
            }
          >
            {liveIds.map((id) => {
              const session = sessions.find((s) => s.id === id);
              if (!session) return null;
              const index = members.indexOf(id);
              const shown = index >= 0 && (zoomed === null || zoomed === id);

              let style: React.CSSProperties | undefined;
              if (zoomed === id) {
                style = { position: 'absolute', inset: 0 };
              } else if (manual) {
                const r = geom?.panes.get(id);
                style = r
                  ? { position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h }
                  : undefined;
              } else {
                // Panes stay in creation order in the DOM and are placed by
                // `order`, so rearranging never re-parents a terminal.
                style = { order: index };
              }

              return (
                <Pane
                  key={id}
                  session={session}
                  visible={view === 'terminal' && shown}
                  focused={id === focusedId}
                  zoomed={zoomed === id}
                  style={style}
                  onFocus={() => setFocused(id)}
                  onToggleZoom={() => {
                    setFocused(id);
                    setZoomedId((z) => (z === id ? null : id));
                  }}
                  onDrop={(p, zone) => onDropOnPane(id, p, zone)}
                  onEject={() => onEject(id)}
                />
              );
            })}

            {members.length === 0 && <EmptyGrid onDrop={onDropOnGrid} />}

            {/* A pane-relative drop always splits below the pane it landed on,
                so without these there is no gesture that makes something span
                the whole layout — a shape the tree can hold perfectly well. */}
            {dragging &&
              !zoomed &&
              members.length > 0 &&
              (['top', 'bottom', 'left', 'right'] as const).map((zone) => (
                <EdgeDrop key={zone} zone={zone} onDrop={onDropOnEdge} />
              ))}

            {manual &&
              !zoomed &&
              geom?.handles.map((h) => {
                const node = nodeAt(shownRoot, h.path);
                if (!node || !isSplit(node)) return null;
                return (
                  <Splitter
                    key={`${h.path.join('.')}-${h.index}`}
                    handle={h}
                    fr={node.fr}
                    onPreview={(path, fr) => setLiveRoot(setFractions(root, path, fr))}
                    onCommit={(path, fr) => {
                      setLiveRoot(undefined);
                      commit({ mode: 'manual', root: setFractions(root, path, fr) }, members);
                    }}
                    onReset={(path) =>
                      commit({ mode: 'manual', root: resetFractions(root, path) }, members)
                    }
                  />
                );
              })}
          </div>
        </div>

        {/* Beside the terminal, never instead of it: the terminal stays
            mounted and one click away, so a follow-up after reading the diff
            is typing rather than navigating. */}
        {inspected && (
          <AttemptInspector attempt={inspected} onClose={() => setInspectId(null)} />
        )}
        </div>

        {view === 'board' && (
          <Board
            tasks={tasks}
            sessions={sessions}
            onOpenSession={onOpen}
            onMove={onMoveTask}
            onStart={(task) => {
              setDialogError(null);
              setStarting(task);
            }}
            onResume={onResumeAttempt}
            onInspect={onInspectAttempt}
            onNewTask={() => {
              setDialogError(null);
              setShowNewTask(true);
            }}
            onDeleteTask={onDeleteTask}
          />
        )}

        {view === 'overview' && (
          <Overview
            sessions={sessions}
            onOpen={onOpen}
            onComplete={(id, completed) => void api.setCompleted(id, completed)}
            onClose={(id) => void api.closeSession(id)}
          />
        )}
      </main>

      {error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {showNew && <NewSessionDialog onCancel={() => setShowNew(false)} onCreate={onCreate} />}
      {showNewTask && (
        <NewTaskDialog
          error={dialogError}
          onCancel={() => setShowNewTask(false)}
          onCreate={onCreateTask}
        />
      )}
      {starting && (
        <StartAttemptDialog
          task={starting}
          error={dialogError}
          onCancel={() => setStarting(null)}
          onStart={(agent, prompt) => void onStartAttempt(starting, agent, prompt)}
        />
      )}
      {showEnv && <EnvPanel boot={boot} onClose={() => setShowEnv(false)} />}
    </div>
  );
}
