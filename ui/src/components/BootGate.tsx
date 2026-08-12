import { useT } from '../i18n';
import type { BootStatus } from '../types';

export function BootGate({ boot, onRetry }: { boot: BootStatus | null; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="boot">
      <h1>Marol</h1>
      {boot?.error ? (
        <>
          <p className="boot-error">{boot.error}</p>
          <ul className="muted">
            <li>{t('boot.node')}</li>
            {/* The build command is only followable by someone running from
                source. In a shipped .dmg/.msi/.AppImage there is no checkout
                to run it in, so the requirement is stated and the command is
                not. */}
            <li>
              {t('boot.sidecar')}
              {import.meta.env.DEV && <code className="mono">npm --prefix sidecar run build</code>}
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
