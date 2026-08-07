import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
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
  const t = useT();
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
            onChange={(e) => setAgent(e.target.value)}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

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
            onClick={() => onStart(agent, prompt)}
          >
            {willSend ? t('common.start') : t('attempt.openNoPrompt')}
          </button>
        </div>
      </div>
    </div>
  );
}
