import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { PermissionMode, Task } from '../types';

interface Props {
  task: Task;
  onCancel: () => void;
  onStart: (agent: string, prompt: string, mode: PermissionMode) => void;
  error: string | null;
}

const AGENTS = ['claude', 'codex', 'gemini', 'aider'];

/** Offered in this order: each step down asks less. */
const MODES: readonly PermissionMode[] = ['normal', 'accept_edits', 'yolo'];

const MODE_KEY = {
  normal: 'mode.normal',
  accept_edits: 'mode.accept_edits',
  yolo: 'mode.yolo',
} as const;

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
  const t = useT();
  const [agent, setAgent] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('normal');
  const [willSend, setWillSend] = useState(true);
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState(false);

  // Only Claude Code's permission flags are measured, so only its sessions
  // get the choice. This dialog is also the safety gate's shape: modes exist
  // for attempts alone, never for ad-hoc sessions — an attempt can only
  // spend its own worktree and branch.
  const modeChoice = agent === 'claude';

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

  // The agent's name is emphasised inside the sentence, so it is spliced back
  // in rather than each language carrying markup.
  const [warnBefore, warnAfter] = t('attempt.unmeasuredHint').split('{agent}');

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('attempt.startTitle', { title: task.title })}</h2>

        <label>{t('attempt.agent')}</label>
        <div className="row">
          <select
            value={agent}
            data-testid="attempt-agent"
            onChange={(e) => {
              setAgent(e.target.value);
              // A mode chosen for claude must not ride silently into a CLI
              // it was never measured against.
              if (e.target.value !== 'claude') setMode('normal');
            }}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {modeChoice && (
            <select
              value={mode}
              data-testid="attempt-mode"
              onChange={(e) => setMode(e.target.value as PermissionMode)}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(MODE_KEY[m])}
                </option>
              ))}
            </select>
          )}
        </div>
        {modeChoice && mode === 'yolo' && (
          <p className="dialog-warn small" data-testid="yolo-hint">
            {t('attempt.yoloHint')}
          </p>
        )}

        <label>{t('attempt.firstPrompt')}</label>
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
          <p className="muted small">{t('attempt.trustHint')}</p>
        ) : (
          <p className="dialog-warn small" data-testid="attempt-manual">
            {warnBefore}
            <strong>{agent}</strong>
            {warnAfter}
            <button
              className="chip"
              data-testid="attempt-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(prompt);
                setCopied(true);
              }}
            >
              {copied ? t('attempt.copied') : t('attempt.copyPrompt')}
            </button>
          </p>
        )}

        {error && (
          <p className="dialog-error" role="alert" data-testid="attempt-error">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={prompt.trim() === ''}
            data-testid="attempt-start"
            onClick={() => onStart(agent, prompt, mode)}
          >
            {willSend ? t('common.start') : t('attempt.openNoPrompt')}
          </button>
        </div>
      </div>
    </div>
  );
}
