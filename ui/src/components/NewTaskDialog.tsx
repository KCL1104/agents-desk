import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import { useT } from '../i18n';
import { chord } from '../platform';
import { composePath, storedWorld, type World } from '../worlds';
import { Modal } from './Modal';
import { WorldSelect } from './WorldSelect';
import { FriendlyError } from './FriendlyError';

interface Props {
  onCancel: () => void;
  onCreate: (title: string, prompt: string, repoPath: string, baseBranch: string) => void | Promise<void>;
  /** Set when the core refused the repository or the base branch. */
  error: string | null;
  /** A goal typed into the palette, taken as the prompt. Empty when the
   *  dialog was opened the ordinary way. */
  goal?: string;
}

const RECENT_KEY = 'agentdesk.recentRepos';

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
 * A card is a repository, a base branch, and something to do.
 *
 * The repository and the branch are checked when the card is made rather than
 * when someone first tries to run it, so a card that can never produce an
 * attempt cannot sit on the board looking like work.
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
  /** Creating checks the repository on disk, which takes real time on a
   *  WSL or SSH host — and a button still live during it makes two cards
   *  from one double-click. Same discipline as the Finish footer. */
  const [busy, setBusy] = useState(false);
  /** The typed repository's branches, most recently committed first. */
  const [branches, setBranches] = useState<string[]>([]);
  /** Whether the person has touched the base field. A default is a guess;
   *  it may be corrected by what the repository actually has — but never
   *  over something someone typed. */
  const branchEdited = useRef(false);
  const list = recents();

  // Ask the repository itself, once the path stops moving. The cleanup is
  // the staleness guard: a fetch for a path no longer in the field can
  // neither land in the list nor rewrite the base.
  useEffect(() => {
    const path = repo.trim() === '' ? '' : composePath(world, repo);
    if (path === '') {
      setBranches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api
        .listBranches(path)
        .then((found) => {
          if (!live) return;
          setBranches(found);
          if (found.length > 0) {
            setBranch((cur) =>
              branchEdited.current || found.includes(cur)
                ? cur
                : found.includes('main')
                  ? 'main'
                  : found[0],
            );
          }
        })
        .catch(() => {
          // Not a repository (yet) — half-typed paths land here on every
          // keystroke, and the create step still checks for real.
          if (live) setBranches([]);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repo, world]);

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setRepo(picked);
  };

  // 標題是選填:一張卡真正非有不可的是 repo 和「要做什麼」——
  // prompt 的第一行本來就是多數人會打的標題。
  const ready = prompt.trim() !== '' && repo.trim() !== '';
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
      onCreate(finalTitle, prompt.trim(), composePath(world, repo), branch.trim()),
    ).finally(() => setBusy(false));
  };

  /** Enter finishes the form from any single-line field — but never the
   *  Enter that is confirming an IME composition, which zh-TW typing ends
   *  every phrase with. */
  const submitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
  };

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

        <label>{t('newTask.repo')}</label>
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
