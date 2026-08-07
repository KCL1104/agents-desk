import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

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

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新卡片</h2>

        <label>標題</label>
        <input
          value={title}
          placeholder="修好登入頁在 Safari 的白畫面"
          data-testid="task-title"
          onChange={(e) => setTitle(e.target.value)}
        />

        <label>要 agent 做什麼</label>
        <textarea
          rows={5}
          value={prompt}
          data-testid="task-prompt"
          placeholder="登入後畫面全白，console 沒有錯誤。先重現再修。"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="muted small">
          不用寫 CLAUDE.md、skills 或 MCP 的事 —— worktree 裡會原生載入。開 attempt
          時會補上分支與 base 的說明，而且送出前可以改。
        </p>

        <label>Repo</label>
        <div className="row">
          <input
            className="mono"
            value={repo}
            data-testid="task-repo"
            placeholder="/Users/you/code/your-repo"
            onChange={(e) => setRepo(e.target.value)}
          />
          <button onClick={pick}>選擇…</button>
        </div>

        {list.length > 0 && (
          <div className="recents">
            {list.map((r) => (
              <button key={r} className="chip mono" onClick={() => setRepo(r)}>
                {r.split('/').filter(Boolean).slice(-1)[0]}
              </button>
            ))}
          </div>
        )}

        <label>Base 分支</label>
        <input
          className="mono"
          value={branch}
          data-testid="task-branch"
          onChange={(e) => setBranch(e.target.value)}
        />
        <p className="muted small">
          每個 attempt 從這裡開一個 worktree 與分支，diff 也以這裡為基準。
        </p>

        {error && (
          <p className="dialog-error" role="alert" data-testid="task-error">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={!ready}
            data-testid="task-create"
            onClick={() => onCreate(title.trim(), prompt.trim(), repo.trim(), branch.trim())}
          >
            建立
          </button>
        </div>
      </div>
    </div>
  );
}
