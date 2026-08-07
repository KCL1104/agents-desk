import { LOCALE_NAME, LOCALES, useI18n, type Locale } from '../i18n';
import type { BootStatus } from '../types';

/**
 * Shows what environment the agents actually get. A GUI process inherits a
 * stub PATH, so this is the panel to check when an MCP server or a toolchain
 * behaves differently here than in Terminal.app.
 *
 * The language picker lives here because this is already the panel about how
 * the app itself is set up, rather than about any one session.
 */
export function EnvPanel({ boot, onClose }: { boot: BootStatus; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('common.env')}</h2>

        <label htmlFor="locale-select">{t('env.language')}</label>
        <select
          id="locale-select"
          data-testid="locale-select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAME[l]}
            </option>
          ))}
        </select>

        <Stat label={t('env.shell')} value={boot.shell ?? '—'} />
        <Stat
          label={t('env.source')}
          value={boot.envResolved ? t('env.sourceLogin') : t('env.sourceProcess')}
        />
        <Stat label={t('env.varCount')} value={String(boot.envVarCount ?? 0)} />
        <Stat label={t('env.claude')} value={boot.claude ?? t('env.claudeMissing')} />
        <Stat label={t('env.db')} value={boot.db ?? '—'} />

        {!boot.envResolved && <p className="muted small">{t('env.degraded')}</p>}

        <label>PATH</label>
        <div className="chips">
          {(boot.path ?? '')
            .split(':')
            .filter(Boolean)
            .map((p, i) => (
              <span className="chip mono" key={`${p}-${i}`}>
                {p}
              </span>
            ))}
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value mono" title={value}>
        {value}
      </span>
    </div>
  );
}
