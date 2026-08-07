import type { BootStatus } from '../types';

/**
 * Shows what environment the agents actually get. A GUI process inherits a
 * stub PATH, so this is the panel to check when an MCP server or a toolchain
 * behaves differently here than in Terminal.app.
 */
export function EnvPanel({ boot, onClose }: { boot: BootStatus; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>環境</h2>

        <Stat label="shell" value={boot.shell ?? '—'} />
        <Stat
          label="環境來源"
          value={boot.envResolved ? 'login shell ✓' : 'process env（降級）'}
        />
        <Stat label="變數數量" value={String(boot.envVarCount ?? 0)} />
        <Stat label="claude" value={boot.claude ?? '找不到'} />
        <Stat label="資料庫" value={boot.db ?? '—'} />

        {!boot.envResolved && (
          <p className="muted small">
            無法從 login shell 取得環境，已退回本行程的環境。npx 型的 MCP server 可能起不來。
          </p>
        )}

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
            關閉
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
