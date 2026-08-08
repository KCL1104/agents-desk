import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../i18n';
import { splitArgs } from '../profiles';
import { useLaunchers } from './launchers';
import { Modal } from './Modal';

interface Props {
  onCancel: () => void;
  onCreate: (cwd: string, agent: string, args: string[]) => void;
}

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

export function NewSessionDialog({ onCancel, onCreate }: Props) {
  const t = useT();
  const [cwd, setCwd] = useState(recents()[0] ?? '');
  const [agent, setAgent] = useState('claude');
  const [args, setArgs] = useState('');
  const launchers = useLaunchers();
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

  // The hint reads better with `cd` set as code, so it is spliced back into
  // the translated sentence rather than each language carrying markup.
  const [hintBefore, hintAfter] = t('newSession.cwdHint').split('{cd}');

  return (
    <Modal onCancel={onCancel} dirty={args.trim() !== ''}>
        <h2>{t('newSession.title')}</h2>

        <label>{t('newSession.cwd')}</label>
        <div className="row">
          <input
            className="mono"
            value={cwd}
            placeholder="/Users/you/code/your-repo"
            onChange={(e) => setCwd(e.target.value)}
          />
          <button onClick={pick}>{t('common.choose')}</button>
        </div>
        <p className="muted small">
          {hintBefore}
          <code className="mono">cd</code>
          {hintAfter}
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
            {launchers.map((l) => (
              <option key={l.name} value={l.name}>
                {l.profile ? `${l.name} · ${l.agent}` : l.name}
              </option>
            ))}
          </select>
        </div>

        <label>{t('newSession.args')}</label>
        <input
          className="mono"
          value={args}
          placeholder="--continue     --model sonnet"
          onChange={(e) => setArgs(e.target.value)}
        />
        <p className="muted small">{t('newSession.argsHint')}</p>

        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button className="primary" disabled={!cwd.trim()} onClick={create}>
            {t('newSession.submit')}
          </button>
        </div>
    </Modal>
  );
}
