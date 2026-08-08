import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { FriendlyError } from './FriendlyError';

interface Props {
  onCancel: () => void;
  onCreate: (title: string, prompt: string, repoPath: string, baseBranch: string) => void;
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
  const list = recents();

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setRepo(picked);
  };

  const ready = title.trim() !== '' && prompt.trim() !== '' && repo.trim() !== '';
  const dirty = title.trim() !== '' || prompt.trim() !== '';

  return (
    <Modal onCancel={onCancel} dirty={dirty}>
        <h2>{t('newTask.title')}</h2>

        <label>{t('newTask.titleLabel')}</label>
        <input
          value={title}
          placeholder={t('newTask.titlePlaceholder')}
          data-testid="task-title"
          onChange={(e) => setTitle(e.target.value)}
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
          onChange={(e) => setBranch(e.target.value)}
        />
        <p className="muted small">{t('newTask.baseHint')}</p>

        {error && <FriendlyError text={error} testid="task-error" />}

        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={!ready}
            data-testid="task-create"
            onClick={() => onCreate(title.trim(), prompt.trim(), repo.trim(), branch.trim())}
          >
            {t('common.create')}
          </button>
        </div>
    </Modal>
  );
}
