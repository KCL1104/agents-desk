import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import { useT } from '../i18n';
import { chord } from '../platform';
import type { TaskRepo } from '../types';
import { composePath, storedWorld, type World } from '../worlds';
import { Modal } from './Modal';
import { WorldSelect } from './WorldSelect';
import { FriendlyError } from './FriendlyError';

interface Props {
  onCancel: () => void;
  onCreate: (
    title: string,
    prompt: string,
    repoPath: string,
    baseBranch: string,
    extraRepos: TaskRepo[],
  ) => void | Promise<void>;
  /** Set when the core refused the repository or the base branch. */
  error: string | null;
  /** A goal typed into the palette, taken as the prompt. Empty when the
   *  dialog was opened the ordinary way. */
  goal?: string;
}

/** One of the repositories beside the first, while the dialog is open. */
interface Extra {
  /** Stable for as long as the row exists, so React keys the row to the row
   *  rather than to its position. Keyed by index, removing one would hand
   *  the survivor the removed row's component — and with it the removed
   *  row's debounced branch lookup, which lands a moment later and rewrites
   *  a base nobody touched. */
  key: number;
  repo: string;
  branch: string;
  /** Whether the base has been typed into. A default is a guess; it may be
   *  corrected by what the repository actually has — but never over
   *  something somebody wrote. */
  edited: boolean;
}

const RECENT_KEY = 'marol.recentRepos';

function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function rememberRepo(path: string) {
  const next = [path, ...recents().filter((r) => r !== path)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

/**
 * The branches a repository has, asked of the repository itself once the path
 * stops moving.
 *
 * The cleanup is the staleness guard: a fetch for a path no longer in the
 * field can never land. A path that is not a repository (yet) answers with an
 * empty list rather than an error — half-typed paths land there on every
 * keystroke, and the create step still checks for real.
 */
function useBranches(path: string): string[] {
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => {
    if (path === '') {
      setBranches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api
        .listBranches(path)
        .then((found) => {
          if (live) setBranches(found);
        })
        .catch(() => {
          if (live) setBranches([]);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);
  return branches;
}

/** What a repository's base should read as, given what it turned out to
 *  have. `main` when it is there, otherwise its most recent branch — and
 *  never over a name somebody typed. */
function correctedBase(found: string[], current: string, edited: boolean): string {
  if (edited || found.length === 0 || found.includes(current)) return current;
  return found.includes('main') ? 'main' : found[0];
}

/** Enter finishes the form from any single-line field — but never the Enter
 *  that is confirming an IME composition, which zh-TW typing ends every
 *  phrase with. */
function onEnter(submit: () => void) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
  };
}

/**
 * One repository beside the first: the same two fields, plus the button that
 * takes the row back off again.
 *
 * The world is the card's, not the row's — every repository on a card has to
 * live in one, because the checkouts share a directory and a directory
 * cannot straddle the boundary into a WSL distro or an SSH host. Offering a
 * per-row world picker would be offering a card the core will refuse.
 */
function ExtraRepo({
  n,
  world,
  value,
  onChange,
  onDrop,
  onSubmit,
}: {
  n: number;
  world: World;
  value: Extra;
  onChange: (patch: Partial<Extra>) => void;
  onDrop: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const path = value.repo.trim() === '' ? '' : composePath(world, value.repo);
  const branches = useBranches(path);
  const corrected = correctedBase(branches, value.branch, value.edited);
  // Settles in one pass: when they differ the correction goes up, and the
  // re-run sees them equal and does nothing.
  useEffect(() => {
    if (corrected !== value.branch) onChange({ branch: corrected });
  }, [corrected, value.branch]);

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') onChange({ repo: picked });
  };

  return (
    <>
      <div className="row between">
        <label>{t('newTask.repoN', { n: String(n) })}</label>
        <button className="quiet" data-testid={`task-drop-repo-${n}`} onClick={onDrop}>
          {t('newTask.dropRepo')}
        </button>
      </div>
      <div className="row">
        <input
          className="mono"
          value={value.repo}
          data-testid={`task-repo-${n}`}
          autoFocus
          placeholder={world === '' ? '~/code/the-other-one' : '/home/you/the-other-one'}
          onChange={(e) => onChange({ repo: e.target.value })}
          onKeyDown={onEnter(onSubmit)}
        />
        <button onClick={pick}>{t('common.choose')}</button>
      </div>

      <label>{t('newTask.baseN', { n: String(n) })}</label>
      <input
        className="mono"
        value={value.branch}
        data-testid={`task-branch-${n}`}
        list={`branch-options-${n}`}
        onChange={(e) => onChange({ branch: e.target.value, edited: true })}
        onKeyDown={onEnter(onSubmit)}
      />
      <datalist id={`branch-options-${n}`}>
        {branches.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
    </>
  );
}

/**
 * A card is one or more repositories, a base branch for each, and something
 * to do.
 *
 * Every repository and branch is checked when the card is made rather than
 * when someone first tries to run it, so a card that can never produce an
 * attempt cannot sit on the board looking like work.
 *
 * The second repository is deliberately behind a button rather than in the
 * form: nearly every card has one, and a form that asks about the case that
 * is rare makes everyone pay for it. Pressing it is the whole of the
 * ceremony — the row that appears is the same two fields as the first.
 */
export function NewTaskDialog({ onCancel, onCreate, error, goal = '' }: Props) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState(goal);
  const [repo, setRepo] = useState(recents()[0] ?? '');
  /** Which world the repo path lives in — defaulted from the bottom-left
      picker, overridable per card. The scheme never rides the keyboard:
      `composePath` assembles it, and pasted schemes or \\wsl$ UNC paths
      win over the dropdown. */
  const [world, setWorld] = useState<World>(storedWorld);
  const [branch, setBranch] = useState('main');
  /** The repositories beside the first. Empty for nearly every card. */
  const [extras, setExtras] = useState<Extra[]>([]);
  /** Only ever counts up: a key a removed row had must never come back. */
  const nextKey = useRef(0);
  /** Creating checks the repository on disk, which takes real time on a
   *  WSL or SSH host — and a button still live during it makes two cards
   *  from one double-click. Same discipline as the Finish footer. */
  const [busy, setBusy] = useState(false);
  /** Whether the person has touched the base field. See `correctedBase`. */
  const branchEdited = useRef(false);
  const list = recents();

  const repoPath = repo.trim() === '' ? '' : composePath(world, repo);
  /** The typed repository's branches, most recently committed first. */
  const branches = useBranches(repoPath);
  useEffect(() => {
    setBranch((cur) => correctedBase(branches, cur, branchEdited.current));
  }, [branches]);

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setRepo(picked);
  };

  const addExtra = () =>
    setExtras((cur) => [
      ...cur,
      { key: (nextKey.current += 1), repo: '', branch: 'main', edited: false },
    ]);

  const editExtra = (i: number, patch: Partial<Extra>) =>
    setExtras((cur) => cur.map((e, n) => (n === i ? { ...e, ...patch } : e)));

  // 標題是選填:一張卡真正非有不可的是 repo 和「要做什麼」——
  // prompt 的第一行本來就是多數人會打的標題。
  // 加出來卻留白的那一列擋著送出:它是有人按了按鈕才存在的,無聲丟掉會讓
  // 卡片少一個 repo 而沒人知道。
  const ready =
    prompt.trim() !== '' && repo.trim() !== '' && extras.every((e) => e.repo.trim() !== '');
  const dirty = title.trim() !== '' || prompt.trim() !== '';

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    // 標題留白的規則(確定性,同一份 prompt 永遠得到同一個標題):
    // trim 後取第一個換行前的內容,再 trim、截到前 80 個字元。
    // 打了字的標題永遠優先 —— 這裡只補空白,不改寫任何人寫的字。
    const fallback = prompt.trim().split('\n')[0].trim().slice(0, 80);
    const finalTitle = title.trim() !== '' ? title.trim() : fallback;
    void Promise.resolve(
      onCreate(
        finalTitle,
        prompt.trim(),
        composePath(world, repo),
        branch.trim(),
        extras.map((e) => ({
          repo_path: composePath(world, e.repo),
          base_branch: e.branch.trim(),
        })),
      ),
    ).finally(() => setBusy(false));
  };

  /** Enter finishes the form from any single-line field — but never the
   *  Enter that is confirming an IME composition, which zh-TW typing ends
   *  every phrase with. */
  const submitOnEnter = onEnter(submit);

  return (
    <Modal onCancel={onCancel} dirty={dirty} onSubmit={submit}>
        <h2>{t('newTask.title')}</h2>

        {/* 目標第一。原本第一眼看到的是「標題(選填)」—— 一個可以留白的
            欄位站在最前面,等於一開口就要人做一個不必做的決定。 */}
        <label>{t('newTask.promptLabel')}</label>
        <textarea
          rows={5}
          autoFocus
          value={prompt}
          data-testid="task-prompt"
          // 多行欄位裡 Enter 是換行;送出的 ⌘/Ctrl+Enter 由 Modal 綁在整個
          // 對話框上 —— 按鈕上印著那顆和弦,它就必須處處為真。
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="muted small">{t('newTask.promptHint')}</p>

        <label>{t('newTask.titleLabel')}</label>
        <input
          value={title}
          data-testid="task-title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={submitOnEnter}
        />
        <p className="muted small">{t('newTask.titleHint')}</p>

        <WorldSelect value={world} onChange={setWorld} testid="task-world" />

        {/* The affordance rides the label of the thing it repeats, exactly
            as each extra row's own remove does. It used to sit on a row of
            its own under the base field, with a paragraph explaining the
            feature — and those two together turned a dialog that had always
            opened fully visible into one that opens already scrolled. What
            the feature is belongs in the README; what this button does is
            legible from the row it makes. */}
        <div className="row between">
          <label>{t('newTask.repo')}</label>
          <button className="quiet" data-testid="task-add-repo" onClick={addExtra}>
            ＋ {t('newTask.addRepo')}
          </button>
        </div>
        <div className="row">
          <input
            className="mono"
            value={repo}
            data-testid="task-repo"
            // 平台中立的示例:app 在三個平台出貨,/Users 只對 macOS 誠實。
            placeholder={world === '' ? '~/code/your-repo' : '/home/you/project'}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={submitOnEnter}
          />
          <button onClick={pick}>{t('common.choose')}</button>
        </div>
        <p className="muted small">{t('newTask.repoHint')}</p>

        {list.length > 0 && (
          <div className="recents">
            {list.map((r) => (
              <button key={r} className="chip mono" onClick={() => setRepo(r)}>
                {r.split('/').filter(Boolean).slice(-1)[0]}
              </button>
            ))}
          </div>
        )}

        <label>{t('newTask.base')}</label>
        <input
          className="mono"
          value={branch}
          data-testid="task-branch"
          // The datalist is the picker: the browser filters as you type,
          // recency order preserved, and a branch not in the list is still
          // typeable — the create step checks it for real.
          list="branch-options"
          onChange={(e) => {
            branchEdited.current = true;
            setBranch(e.target.value);
          }}
          onKeyDown={submitOnEnter}
        />
        <datalist id="branch-options">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <p className="muted small">{t('newTask.baseHint')}</p>

        {extras.map((extra, i) => (
          <ExtraRepo
            key={extra.key}
            n={i + 2}
            world={world}
            value={extra}
            onChange={(patch) => editExtra(i, patch)}
            onDrop={() => setExtras((cur) => cur.filter((_, n) => n !== i))}
            onSubmit={submit}
          />
        ))}

        {error && <FriendlyError text={error} testid="task-error" />}

        <div className="modal-actions">
          <button onClick={onCancel}>
            {t('common.cancel')}
            <kbd>Esc</kbd>
          </button>
          <button
            className="primary"
            disabled={!ready || busy}
            data-testid="task-create"
            onClick={submit}
          >
            {busy ? t('inspector.working') : t('common.create')}
            <kbd>{chord('↵')}</kbd>
          </button>
        </div>
    </Modal>
  );
}
