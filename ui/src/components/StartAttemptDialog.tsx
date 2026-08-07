import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';

interface Props {
  task: Task;
  onCancel: () => void;
  onStart: (agent: string, prompt: string) => void;
  error: string | null;
}

const AGENTS = ['claude', 'codex', 'gemini', 'aider'];

/**
 * The first message, shown in full and editable before anything is spawned.
 *
 * Editable because the template cannot know what this particular go at the
 * card needs, and because being able to see exactly what the agent will be
 * told is the difference between driving it and hoping. What is sent is what
 * gets written to the attempt's timeline, so the record is what happened
 * rather than what the template would have produced.
 */
export function StartAttemptDialog({ task, onCancel, onStart, error }: Props) {
  const [agent, setAgent] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [willSend, setWillSend] = useState(true);
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-render the preview when the agent changes, unless it has been edited —
  // silently discarding someone's typing to refresh a template is worse than
  // showing a preview that names the previous agent.
  useEffect(() => {
    let live = true;
    void api
      .previewPrompt(task.id, agent)
      .then((p) => {
        if (!live) return;
        setWillSend(p.willSend);
        if (!edited) setPrompt(p.prompt);
      })
      .catch(() => {
        /* the dialog still works; the core will report on start */
      });
    return () => {
      live = false;
    };
  }, [task.id, agent, edited]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>開始 attempt — {task.title}</h2>

        <label>Agent</label>
        <div className="row">
          <select
            value={agent}
            data-testid="attempt-agent"
            onChange={(e) => setAgent(e.target.value)}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <label>首則 prompt</label>
        <textarea
          rows={14}
          className="mono"
          value={prompt}
          data-testid="attempt-prompt"
          onChange={(e) => {
            setEdited(true);
            setPrompt(e.target.value);
          }}
        />

        {willSend ? (
          <p className="muted small">
            送出後會開一個新的 worktree —— Claude Code 會先問你信不信任這個資料夾，
            卡片會亮起「⚠ 等你確認資料夾」。答完之後這則 prompt 就會送出。
          </p>
        ) : (
          <p className="dialog-warn small" data-testid="attempt-manual">
            <strong>{agent}</strong> 的參數慣例我們沒有實測過，所以不會自動送出 ——
            在某個 CLI 代表「這是你的 prompt」的參數，在另一個可能代表「印出來然後結束」。
            session 照樣會開，把下面這段複製貼進去即可。
            <button
              className="chip"
              data-testid="attempt-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(prompt);
                setCopied(true);
              }}
            >
              {copied ? '已複製' : '複製 prompt'}
            </button>
          </p>
        )}

        {error && (
          <p className="dialog-error" role="alert" data-testid="attempt-error">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={prompt.trim() === ''}
            data-testid="attempt-start"
            onClick={() => onStart(agent, prompt)}
          >
            {willSend ? '開始' : '開 session（不送 prompt）'}
          </button>
        </div>
      </div>
    </div>
  );
}
