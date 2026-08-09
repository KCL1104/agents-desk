import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Icon } from './Icon';

interface Props {
  /** The dev server's port on localhost. */
  port: number;
  /** Whether the script session that owns the server is still alive. A
      dead server gets a cover that says so — blank and broken must never
      look alike. */
  live: boolean;
  /** The element last picked inside the page, via the opt-in inspect
      script's postMessage. See docs/examples/agentdesk-inspect.js. */
  pick: { component: string; file: string; line: number } | null;
  /** Send the pick into the attempt's terminal — offered only when the
      session is live and its CLI's input conventions are measured.
      Sending stays a human act. */
  onTell: (() => void) | null;
  onDismissPick: () => void;
  onClose: () => void;
}

/**
 * The dev server, on the desk.
 *
 * An iframe on the peek's patch of ground — seeing, without touching: the
 * page is exactly what the server sent, never proxied, never injected
 * (the decision docs/decisions/dev-preview.md exists to defend). The app
 * and the page are cross-origin strangers; the one sanctioned channel is
 * the inspect script's postMessage, and installing that is the repo's own
 * choice.
 */
export function PreviewPanel({ port, live, pick, onTell, onDismissPick, onClose }: Props) {
  const t = useT();
  const url = `http://localhost:${port}`;
  /** null = probing. False gets words, not a blank frame. */
  const [listening, setListening] = useState<boolean | null>(null);
  /** Bumping remounts the iframe — the only reload a cross-origin frame
      allows us. */
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);

  const probe = useCallback(() => {
    setListening(null);
    void api
      .probePort(port)
      .then(setListening)
      .catch(() => setListening(false));
  }, [port]);

  // Probe on open, and again whenever the server's terminal comes or goes.
  useEffect(() => {
    if (live) probe();
  }, [live, probe]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <aside className="preview-panel" data-testid="preview-panel" aria-label={t('preview.title')}>
      <header className="preview-head">
        <span className="mono small preview-url" title={url}>
          {url}
        </span>
        <button
          className="chip"
          data-testid="preview-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? t('attempt.copied') : t('preview.copy')}
        </button>
        <button
          className="icon"
          data-testid="preview-reload"
          title={t('preview.reload')}
          aria-label={t('preview.reload')}
          onClick={() => {
            probe();
            setNonce((n) => n + 1);
          }}
        >
          <Icon name="reload" />
        </button>
        <button
          className="icon"
          title={t('preview.external')}
          aria-label={t('preview.external')}
          onClick={() => void api.openExternal(url)}
        >
          ↗
        </button>
        <button className="icon" onClick={onClose} title={t('preview.close')} aria-label={t('preview.close')}>
          ✕
        </button>
      </header>

      {/* The pick, worn where it happened. The words are the same ones the
          agent would receive; sending them is the human's click. */}
      {pick !== null && (
        <p className="preview-pick small" data-testid="preview-pick" aria-live="polite">
          <span className="mono">
            {t('preview.pick', { component: pick.component, file: pick.file, line: pick.line })}
          </span>
          {onTell !== null && (
            <button className="chip" data-testid="preview-tell" onClick={onTell}>
              {t('ckpt.tell')}
            </button>
          )}
          <button className="chip" aria-label={t('common.close')} onClick={onDismissPick}>
            ✕
          </button>
        </p>
      )}

      {!live ? (
        <div className="preview-cover" data-testid="preview-dead">
          <p className="muted">{t('preview.dead')}</p>
        </div>
      ) : listening === false ? (
        <div className="preview-cover" data-testid="preview-unreachable">
          <p className="muted">{t('preview.notListening', { url })}</p>
          <button onClick={probe}>{t('preview.retry')}</button>
        </div>
      ) : (
        <iframe key={nonce} className="preview-frame" src={url} title={t('preview.title')} />
      )}
    </aside>
  );
}
