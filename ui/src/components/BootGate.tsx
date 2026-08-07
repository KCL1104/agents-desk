import type { BootStatus } from '../types';

export function BootGate({ boot, onRetry }: { boot: BootStatus | null; onRetry: () => void }) {
  return (
    <div className="boot">
      <h1>AgentDesk</h1>
      {boot?.error ? (
        <>
          <p className="boot-error">{boot.error}</p>
          <ul className="muted">
            <li>Node 20+ 必須在你的 login shell PATH 上</li>
            <li>
              sidecar 要先建置：<code className="mono">npm --prefix sidecar run build</code>
            </li>
            <li>Claude Code CLI 必須已安裝並登入</li>
          </ul>
          <button className="primary" onClick={onRetry}>
            重試
          </button>
        </>
      ) : (
        <p className="muted">正在解析 login shell 環境…</p>
      )}
    </div>
  );
}
