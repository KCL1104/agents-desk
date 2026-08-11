import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../i18n';
import { splitArgs } from '../profiles';
import { composePath, storedWorld, type World } from '../worlds';
import { useLaunchers } from './launchers';
import { Modal } from './Modal';
import { WorldSelect } from './WorldSelect';

interface Props {
  onCancel: () => void;
  onCreate: (cwd: string, agent: string, args: string[]) => void;
}

const RECENT_KEY = 'marol.recentCwds';

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
  const [world, setWorld] = useState<World>(storedWorld);
  const [agent, setAgent] = useState('claude');
  const [args, setArgs] = useState('');
  const launchers = useLaunchers();
  const list = recents();

  const pick = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setCwd(picked);
  };

  const create = () => {
    if (cwd.trim() === '') return;
    const dir = composePath(world, cwd);
    remember(dir);
    onCreate(dir, agent, splitArgs(args));
  };

  /** Enter finishes the form from either single-line field — except the
   *  Enter that is confirming an IME composition. */
  const submitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) create();
  };

  // The hint reads better with `cd` set as code, so it is spliced back into
  // the translated sentence rather than each language carrying markup.
  const [hintBefore, hintAfter] = t('newSession.cwdHint').split('{cd}');

  return (
    <Modal onCancel={onCancel} dirty={args.trim() !== ''}>
        <h2>{t('newSession.title')}</h2>

        <WorldSelect value={world} onChange={setWorld} testid="session-world" />

        <label>{t('newSession.cwd')}</label>
        <div className="row">
          <input
            className="mono"
            value={cwd}
            // 平台中立的示例:app 在三個平台出貨,/Users 只對 macOS 誠實。
            placeholder={world === '' ? '~/code/your-repo' : '/home/you/project'}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={submitOnEnter}
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

        <label>{t('attempt.agent')}</label>
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
          onKeyDown={submitOnEnter}
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
