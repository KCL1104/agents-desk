import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { unifiedMergeView } from '@codemirror/merge';
import { api } from '../api';
import { useT } from '../i18n';
import { FriendlyError } from './FriendlyError';

interface Props {
  attemptId: string;
  /** Worktree-relative, straight off the diff header. */
  file: string;
  /** Whether the last save is still unsent to the agent — the tell chip's
      life. Null when this session cannot be told (not claude, not live). */
  onTell: (() => void) | null;
  /** The save landed: the parent refreshes the diff and clears the file's
      viewed mark — it changed, so "seen" has expired. */
  onSaved: () => void;
  /** Ask to leave. The parent owns the dirty confirmation, because closing
      arrives from more than one door — the Close chip here, the file's own
      fold button, the edit chip toggling off. */
  onRequestClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * One diff file, opened for writing where it was being read.
 *
 * A CodeMirror unified merge view: the base commit's copy shown inline and
 * read-only, the worktree's copy editable. The base side is history, not a
 * document — editing it is not on offer. Saving is explicit (button or ⌘S,
 * never auto): an auto-save would write "still thinking" onto the disk the
 * agent is about to re-read.
 */
export function FileEditor({ attemptId, file, onTell, onSaved, onRequestClose, onDirtyChange }: Props) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** What the disk holds, as far as we know — dirty means differing from
      this, not from the load. */
  const savedText = useRef<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Worn briefly by the save button; the offer to tell the agent stays
      until the text moves again. */
  const [saidSaved, setSaidSaved] = useState(false);
  const [tellable, setTellable] = useState(false);

  // The handler props live in refs so the editor is built once per file,
  // not rebuilt on every parent render.
  const handlers = useRef({ onDirtyChange, onSaved, onRequestClose });
  handlers.current = { onDirtyChange, onSaved, onRequestClose };

  useEffect(() => {
    if (saidSaved === false) return;
    const timer = setTimeout(() => setSaidSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saidSaved]);

  const save = () => {
    const v = view.current;
    if (v === null || saving) return;
    const text = v.state.doc.toString();
    setSaving(true);
    setSaveError(null);
    // `savedText` rides along as the freshness contract: if the disk no
    // longer holds what this editor read, the core refuses instead of
    // letting this save erase a shell's or a later turn's work unseen.
    void api
      .writeAttemptFile(attemptId, file, text, savedText.current)
      .then(() => {
        savedText.current = text;
        setDirty(false);
        handlers.current.onDirtyChange(false);
        setSaidSaved(true);
        setTellable(true);
        handlers.current.onSaved();
      })
      // The refusal in full — the core's mid-turn explanation is the
      // guard actually holding, and it names what to do next.
      .catch((e) => setSaveError(String(e)))
      .finally(() => setSaving(false));
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let dead = false;
    setLoadError(null);
    void api
      .attemptFile(attemptId, file)
      .then(({ base, work }) => {
        if (dead || host.current === null) return;
        savedText.current = work ?? '';
        view.current = new EditorView({
          doc: work ?? '',
          parent: host.current,
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([
              // Save first, so Mod-s is not left to the browser.
              {
                key: 'Mod-s',
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
              // Esc asks to leave — the same door as the Close chip, so
              // the dirty guard hears it too.
              {
                key: 'Escape',
                run: () => {
                  handlers.current.onRequestClose();
                  return true;
                },
              },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            EditorView.lineWrapping,
            // The base copy inline and read-only; only the worktree side
            // is a document. No merge controls: this is an editor, not a
            // conflict resolver.
            unifiedMergeView({
              original: base ?? '',
              mergeControls: false,
              syntaxHighlightDeletions: false,
            }),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return;
              const d = u.state.doc.toString() !== savedText.current;
              setDirty(d);
              handlers.current.onDirtyChange(d);
              setTellable(false);
            }),
          ],
        });
        view.current.focus();
      })
      .catch((e) => {
        if (!dead) setLoadError(String(e));
      });
    return () => {
      dead = true;
      view.current?.destroy();
      view.current = null;
      handlers.current.onDirtyChange(false);
    };
    // One editor per (attempt, file); everything else rides refs.
  }, [attemptId, file]);

  return (
    <div className="file-editor" data-testid="file-editor">
      {/* The save's answer, spoken as well as worn: the chip swap is
          silence to a screen reader. */}
      <span className="visually-hidden" aria-live="polite">
        {saidSaved ? t('edit.saved') : ''}
      </span>
      <div className="file-editor-bar">
        <button
          className="chip"
          data-testid="editor-save"
          disabled={!dirty || saving}
          title={t('edit.saveHint', { file })}
          onClick={save}
        >
          {saidSaved ? t('edit.saved') : t('edit.save')}
        </button>
        {tellable && onTell !== null && (
          <button
            className="chip"
            data-testid="editor-tell"
            onClick={() => {
              onTell();
              setTellable(false);
            }}
          >
            {t('ckpt.tell')}
          </button>
        )}
        <span className="spacer" />
        <button className="chip" data-testid="editor-close" onClick={onRequestClose}>
          {t('edit.close')}
        </button>
      </div>
      {loadError !== null && (
        <p className="dialog-error" role="alert" data-testid="editor-load-error">
          {t('edit.failed', { file, err: loadError })}
        </p>
      )}
      {saveError !== null && <FriendlyError text={saveError} testid="editor-error" />}
      <div ref={host} className="file-editor-cm" />
    </div>
  );
}
