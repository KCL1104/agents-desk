import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { PermissionMode, Task } from '../types';
import { useLaunchers } from './launchers';
import { Modal } from './Modal';
import { FriendlyError } from './FriendlyError';

interface Props {
  task: Task;
  onCancel: () => void;
  onStart: (agent: string, prompt: string, mode: PermissionMode) => void | Promise<void>;
  error: string | null;
}

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
  /** Starting spawns a worktree and a PTY — a button still live during it
   *  makes two attempts from one double-click. */
  const [busy, setBusy] = useState(false);
  const launchers = useLaunchers();

  // What the picked launcher runs underneath — a profile of claude is still
  // claude for every convention that matters here.
  const resolved = launchers.find((l) => l.name === agent)?.agent ?? agent;

  // Only Claude Code's permission flags are measured, so only its sessions
  // get the choice. This dialog is also the safety gate's shape: modes exist
  // for attempts alone, never for ad-hoc sessions — an attempt can only
  // spend its own worktree and branch.
  const modeChoice = resolved === 'claude';

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
    <Modal onCancel={onCancel} dirty={edited} wide>
        <h2>{t('attempt.startTitle', { title: task.title })}</h2>

        {/* Two labeled columns: the mode select decides whether the agent
            runs unattended, and unlabeled it read as a second agent picker
            — anonymous to everyone, not only to AT. */}
        <div className="row fields">
          <div className="field">
            <label htmlFor="attempt-agent">{t('attempt.agent')}</label>
            <select
              id="attempt-agent"
              value={agent}
              data-testid="attempt-agent"
              onChange={(e) => {
                const next = e.target.value;
                setAgent(next);
                // A mode chosen for claude must not ride silently into a CLI
                // it was never measured against.
                const nextAgent = launchers.find((l) => l.name === next)?.agent ?? next;
                if (nextAgent !== 'claude') setMode('normal');
              }}
            >
              {launchers.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.profile ? `${l.name} · ${l.agent}` : l.name}
                </option>
              ))}
            </select>
          </div>
          {modeChoice && (
            <div className="field">
              <label htmlFor="attempt-mode">{t('attempt.modeLabel')}</label>
              <select
                id="attempt-mode"
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
            </div>
          )}
        </div>
        {modeChoice && mode === 'accept_edits' && (
          <p className="muted small" data-testid="accept-hint">
            {t('attempt.acceptHint')}
          </p>
        )}
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
            {/* The CLI underneath, not the profile's nickname — the warning
                is about the binary's conventions. */}
            <strong>{resolved}</strong>
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

        {error && <FriendlyError text={error} testid="attempt-error" />}

        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className="primary"
            disabled={prompt.trim() === '' || busy}
            data-testid="attempt-start"
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onStart(agent, prompt, mode)).finally(() => setBusy(false));
            }}
          >
            {busy
              ? t('inspector.working')
              : willSend
                ? t('common.start')
                : t('attempt.openNoPrompt')}
          </button>
        </div>
    </Modal>
  );
}
