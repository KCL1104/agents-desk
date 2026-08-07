import { useT } from '../i18n';
import type { BootStatus } from '../types';

export function BootGate({ boot, onRetry }: { boot: BootStatus | null; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="boot">
      <h1>AgentDesk</h1>
      {boot?.error ? (
        <>
          <p className="boot-error">{boot.error}</p>
          <ul className="muted">
            <li>{t('boot.node')}</li>
            <li>
              {t('boot.sidecar')}
              <code className="mono">npm --prefix sidecar run build</code>
            </li>
            <li>{t('boot.claude')}</li>
          </ul>
          <button className="primary" onClick={onRetry}>
            {t('boot.retry')}
          </button>
        </>
      ) : (
        <p className="muted">{t('boot.resolving')}</p>
      )}
    </div>
  );
}
