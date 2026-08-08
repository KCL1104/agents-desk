import { useT } from '../i18n';
import type { BootStatus } from '../types';
import { Modal } from './Modal';

interface Props {
  boot: BootStatus;
  /** Close and go make the first card — the path the board exists for. */
  onNewTask: () => void;
  /** Close and open a plain session instead — no card, no worktree. */
  onNewSession: () => void;
  onClose: () => void;
}

/**
 * The first-run panel: what this machine already has, then the mental
 * model in three sentences.
 *
 * Everything in the detection list is a probe the app has already run —
 * the login-shell environment, each agent CLI on that PATH, the messaging
 * version gate. Onboarding that asks for what the system already knows
 * reads as broken; onboarding that shows its findings earns trust before
 * the first card exists. Shown once, and never to a desk already in use.
 */
export function WelcomeDialog({ boot, onNewTask, onNewSession, onClose }: Props) {
  const t = useT();
  const agents = boot.agents ?? [];

  return (
    <Modal onCancel={onClose}>
      <h2>{t('welcome.title')}</h2>

      <h3 className="modal-section">{t('welcome.found')}</h3>
      <div className="stat">
        <span className="stat-label">{t('env.shell')}</span>
        <span className="stat-value mono">{boot.shell ?? '—'}</span>
      </div>
      <div className="stat">
        <span className="stat-label">{t('env.source')}</span>
        <span className="stat-value mono">
          {boot.envResolved ? t('env.sourceLogin') : t('env.sourceProcess')}
        </span>
      </div>
      {agents.map((a) => (
        <div className="stat" key={a.name} data-testid={`welcome-${a.name}`}>
          <span className="stat-label mono">{a.name}</span>
          {a.path !== null ? (
            <span className="stat-value mono" title={a.path}>
              {/* The one CLI whose version gates features says which. */}
              {a.name === 'claude' && boot.claudeVersion
                ? `✓ ${boot.claudeVersion}`
                : '✓'}
            </span>
          ) : (
            <span className="stat-value mono muted">{t('env.claudeMissing')}</span>
          )}
        </div>
      ))}
      <div className="stat">
        <span className="stat-label">{t('env.messaging')}</span>
        <span className="stat-value mono">
          {boot.messaging
            ? '✓'
            : t('env.messagingOff', { version: boot.claudeVersion ?? '—' })}
        </span>
      </div>

      <h3 className="modal-section">{t('welcome.model')}</h3>
      <ul className="welcome-model">
        <li>{t('welcome.model1')}</li>
        <li>{t('welcome.model2')}</li>
        <li>{t('welcome.model3')}</li>
      </ul>

      <div className="modal-actions">
        <button onClick={onClose}>{t('common.close')}</button>
        <button data-testid="welcome-session" onClick={onNewSession}>
          {t('welcome.newSession')}
        </button>
        <button className="primary" data-testid="welcome-card" onClick={onNewTask}>
          {t('welcome.newCard')}
        </button>
      </div>
    </Modal>
  );
}
