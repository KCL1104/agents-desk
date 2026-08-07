import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

interface Props {
  onCancel: () => void;
  onCreate: (cwd: string, agent: string, args: string[]) => void;
}

const AGENTS = ['claude', 'codex', 'gemini', 'aider'];
const RECENT_KEY = 'agentdesk.recentCwds';

function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function remember(cwd: string) {
  const next = [cwd, ...recents().filter((r) => r !== cwd)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

/** Split a flag string the way a shell would, honouring quotes. */
function splitArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function NewSessionDialog({ onCancel, onCreate }: Props) {
  const [cwd, setCwd] = useState(recents()[0] ?? '');
  const [agent, setAgent] = useState('claude');
  const [args, setArgs] = useState('');
  const list = recents();

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setCwd(picked);
  };

  const create = () => {
    const dir = cwd.trim();
    if (!dir) return;
    remember(dir);
    onCreate(dir, agent, splitArgs(args));
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新 session</h2>

        <label>工作目錄</label>
        <div className="row">
          <input
            className="mono"
            value={cwd}
            placeholder="/Users/you/code/your-repo"
            onChange={(e) => setCwd(e.target.value)}
          />
          <button onClick={pick}>選擇…</button>
        </div>
        <p className="muted small">
          等同於 <code className="mono">cd</code> 到這裡再開 agent —— 載入的 CLAUDE.md、
          .claude/ skills 與 .mcp.json 跟你在終端機做完全一樣。
        </p>

        {list.length > 0 && (
          <div className="recents">
            {list.map((r) => (
              <button key={r} className="chip mono" onClick={() => setCwd(r)}>
                {r.split('/').filter(Boolean).slice(-1)[0]}
              </button>
            ))}
          </div>
        )}

        <label>Agent</label>
        <div className="row">
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <label>啟動參數（可留空）</label>
        <input
          className="mono"
          value={args}
          placeholder="--continue     --model sonnet"
          onChange={(e) => setArgs(e.target.value)}
        />
        <p className="muted small">
          原封不動傳給 CLI，跟你自己在終端機打的一樣。
        </p>

        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={!cwd.trim()} onClick={create}>
            開啟終端機
          </button>
        </div>
      </div>
    </div>
  );
}
