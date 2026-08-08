import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { FriendlyError } from './FriendlyError';

interface Props {
  onCancel: () => void;
  onCreate: (title: string, prompt: string, repoPath: string, baseBranch: string) => void | Promise<void>;
  /** Set when the core refused the repository or the base branch. */
  error: string | null;
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
export function NewTaskDialog({ onCancel, onCreate, error }: Props) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState(recents()[0] ?? '');
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
    const path = repo.trim();
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
  }, [repo]);

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setRepo(picked);
  };

  const ready = title.trim() !== '' && prompt.trim() !== '' && repo.trim() !== '';
  const dirty = title.trim() !== '' || prompt.trim() !== '';

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    void Promise.resolve(
      onCreate(title.trim(), prompt.trim(), repo.trim(), branch.trim()),
    ).finally(() => setBusy(false));
  };

  /** Enter finishes the form from any single-line field — but never the
   *  Enter that is confirming an IME composition, which zh-TW typing ends
   *  every phrase with. */
  const submitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
  };

  return (
    <Modal onCancel={onCancel} dirty={dirty}>
        <h2>{t('newTask.title')}</h2>

        <label>{t('newTask.titleLabel')}</label>
        <input
          value={title}
          placeholder={t('newTask.titlePlaceholder')}
          data-testid="task-title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={submitOnEnter}
        />

        <label>{t('newTask.promptLabel')}</label>
        <textarea
          rows={5}
          value={prompt}
          data-testid="task-prompt"
          placeholder={t('newTask.promptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="muted small">{t('newTask.promptHint')}</p>

        <label>{t('newTask.repo')}</label>
        <div className="row">
          <input
            className="mono"
            value={repo}
            data-testid="task-repo"
            placeholder="/Users/you/code/your-repo"
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
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!ready || busy}
            data-testid="task-create"
            onClick={submit}
          >
            {busy ? t('inspector.working') : t('common.create')}
          </button>
        </div>
    </Modal>
  );
}
