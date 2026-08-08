import { useEffect, useState } from 'react';
import { LOCALE_NAME, LOCALES, useI18n, type Locale } from '../i18n';
import { api } from '../api';
import { joinArgs, splitArgs } from '../profiles';
import type { BootStatus } from '../types';
import { Modal } from './Modal';

/**
 * Shows what environment the agents actually get. A GUI process inherits a
 * stub PATH, so this is the panel to check when an MCP server or a toolchain
 * behaves differently here than in Terminal.app.
 *
 * The language picker lives here because this is already the panel about how
 * the app itself is set up, rather than about any one session. Profiles live
 * here for the same reason: a named way of launching an agent belongs to the
 * desk, not to any one card.
 */
export function EnvPanel({ boot, onClose }: { boot: BootStatus; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  /** Unsaved profile edits guard the backdrop, exactly as a typed prompt
   *  does — the panel mixes settings and diagnostics, and losing the one
   *  to a stray click aimed at the other is the mix's worst failure. */
  const [dirty, setDirty] = useState(false);
  return (
    <Modal onCancel={onClose} dirty={dirty}>
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

        <Profiles onDirty={setDirty} />

        {/* The doctor half: what the agents actually inherit. */}
        <h3 className="modal-section">{t('env.diagnostics')}</h3>
        <Stat label={t('env.shell')} value={boot.shell ?? '—'} />
        <Stat
          label={t('env.source')}
          value={boot.envResolved ? t('env.sourceLogin') : t('env.sourceProcess')}
        />
        <Stat label={t('env.varCount')} value={String(boot.envVarCount ?? 0)} />
        <Stat label={t('env.claude')} value={boot.claude ?? t('env.claudeMissing')} />
        {/* Whether cards' agents can message each other. The feature is the
            CLI's own; what this desk adds is naming each session after its
            card so the messages have somewhere sayable to go. */}
        <Stat
          label={t('env.messaging')}
          value={
            boot.messaging
              ? `✓ · claude ${boot.claudeVersion ?? ''}`.trim()
              : t('env.messagingOff', { version: boot.claudeVersion ?? '—' })
          }
        />
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
    </Modal>
  );
}

/** A row as the editor holds it: args still a string, exactly as typed. */
interface Row {
  name: string;
  agent: string;
  args: string;
}

const AGENTS = ['claude', 'codex', 'gemini', 'aider'];

/**
 * The profile editor: the whole list, edited in place, saved as a whole.
 * There are few enough profiles that per-row saves would only add ways for
 * the screen and the store to disagree. The backend validates the set —
 * empty names, repeats, an agent's own name — and its refusal is shown
 * verbatim, because it names the exact row that cannot be offered.
 */
function Profiles({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api
      .listProfiles()
      .then((list) =>
        setRows(list.map((p) => ({ name: p.name, agent: p.agent, args: joinArgs(p.args) }))),
      )
      .catch((e) => {
        setRows([]);
        setProblem(String(e));
      });
  }, []);

  const edit = (i: number, patch: Partial<Row>) => {
    setSaved(false);
    onDirty(true);
    setRows((cur) => (cur ? cur.map((r, j) => (j === i ? { ...r, ...patch } : r)) : cur));
  };

  const save = (next: Row[]) => {
    setProblem(null);
    setSaved(false);
    void api
      .saveProfiles(
        next.map((r) => ({ name: r.name.trim(), agent: r.agent, args: splitArgs(r.args) })),
      )
      .then(() => {
        setSaved(true);
        onDirty(false);
      })
      .catch((e) => setProblem(String(e)));
  };

  if (rows === null) return null;

  return (
    <div className="profiles" data-testid="profiles">
      <h3 className="modal-section">{t('env.profiles')}</h3>
      <p className="muted small">{t('env.profilesHint')}</p>

      {rows.map((r, i) => (
        <div className="row profile-row" key={i}>
          <input
            value={r.name}
            placeholder={t('profile.namePlaceholder')}
            data-testid={`profile-name-${i}`}
            onChange={(e) => edit(i, { name: e.target.value })}
          />
          <select
            value={r.agent}
            data-testid={`profile-agent-${i}`}
            onChange={(e) => edit(i, { agent: e.target.value })}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            className="mono profile-args"
            value={r.args}
            placeholder="--model opus"
            data-testid={`profile-args-${i}`}
            onChange={(e) => edit(i, { args: e.target.value })}
          />
          <button
            className="icon"
            aria-label={t('profile.remove')}
            title={t('profile.remove')}
            onClick={() => {
              // A draft like every other change here: one save contract for
              // the whole list. Instant-persist deletes next to explicit-save
              // edits meant a mis-clicked ✕ committed while a finished edit
              // silently didn't.
              setSaved(false);
              onDirty(true);
              setRows(rows.filter((_, j) => j !== i));
            }}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="row">
        <button
          data-testid="profile-add"
          onClick={() => {
            setSaved(false);
            onDirty(true);
            setRows([...rows, { name: '', agent: 'claude', args: '' }]);
          }}
        >
          {t('profile.add')}
        </button>
        {/* Always offered: with deletion a draft like any other edit, an
            emptied list still needs its save. */}
        <button className="primary" data-testid="profile-save" onClick={() => save(rows)}>
          {saved ? t('profile.saved') : t('profile.save')}
        </button>
      </div>

      {problem && (
        <p className="dialog-error" role="alert" data-testid="profile-error">
          {problem}
        </p>
      )}
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
