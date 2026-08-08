import { useEffect, useState } from 'react';
import { LOCALE_NAME, LOCALES, useI18n, type Locale } from '../i18n';
import { api } from '../api';
import { joinArgs, splitArgs } from '../profiles';
import type { BootStatus, NotifyPrefs } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';
import {
  applyTheme,
  contrast,
  currentTheme,
  derive,
  loadStored,
  onColor,
  PRESETS,
  type Primaries,
  type StoredTheme,
} from '../theme';

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

        <Theming />

        <Notifications />

        <Checkpoints />

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

/**
 * Which notifications the desk raises. Three toggles, applied on click —
 * a preference is not a form — and a test button, because "is it even
 * working" is otherwise only answerable by waiting for an agent to block.
 * They fire only while the window is elsewhere; in front of the app the
 * interface itself already says everything.
 */
function Notifications() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    void api
      .notifyPrefs()
      .then(setPrefs)
      .catch(() => {
        /* the panel's other sections still work; the row simply stays out */
      });
  }, []);

  if (prefs === null) return null;

  const toggle = (key: keyof NotifyPrefs) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    void api.setNotifyPrefs(next).catch(() => {
      // The next open re-reads what actually stuck.
      setPrefs(prefs);
    });
  };

  const rows: { key: keyof NotifyPrefs; label: string }[] = [
    { key: 'permission', label: t('notify.permission') },
    { key: 'input', label: t('notify.input') },
    { key: 'done', label: t('notify.done') },
  ];

  return (
    <div data-testid="notifications">
      <h3 className="modal-section">{t('env.notifications')}</h3>
      <p className="muted small">{t('notify.hint')}</p>
      {rows.map(({ key, label }) => (
        <label className="notify-row" key={key}>
          <input
            type="checkbox"
            checked={prefs[key]}
            data-testid={`notify-${key}`}
            onChange={() => toggle(key)}
          />
          {label}
        </label>
      ))}
      <div className="row notify-test-row">
        <button
          data-testid="notify-test"
          onClick={() => {
            setTested(true);
            void api.testNotification().catch(() => setTested(false));
          }}
        >
          {tested ? t('notify.sent') : t('notify.test')}
        </button>
      </div>
    </div>
  );
}

/**
 * The one checkpoint setting: whether the end of a turn snapshots the
 * worktree. Default on — the retreat that makes letting an agent run
 * affordable — with the off switch here for repos where the walk costs.
 */
function Checkpoints() {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    void api
      .checkpointsEnabled()
      .then(setOn)
      .catch(() => {
        /* the panel's other sections still work; the row simply stays out */
      });
  }, []);

  if (on === null) return null;

  return (
    <div data-testid="checkpoints">
      <h3 className="modal-section">{t('env.checkpoints')}</h3>
      <p className="muted small">{t('ckpt.hint')}</p>
      <label className="notify-row">
        <input
          type="checkbox"
          checked={on}
          data-testid="ckpt-toggle"
          onChange={() => {
            const next = !on;
            setOn(next);
            void api.setCheckpointsEnabled(next).catch(() => setOn(on));
          }}
        />
        {t('ckpt.onStop')}
      </label>
    </div>
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

/** The six colors a custom theme asks for, in editor order. */
const COLOR_FIELDS: { key: keyof Primaries; label: string }[] = [
  { key: 'bg', label: 'theme.bg' },
  { key: 'fg', label: 'theme.fg' },
  { key: 'accent', label: 'theme.accent' },
  { key: 'ok', label: 'theme.ok' },
  { key: 'warn', label: 'theme.warn' },
  { key: 'err', label: 'theme.err' },
];

/**
 * Theme choice: presets first, each swatch painted in its own colors so the
 * row is the preview. 自訂 opens the six colors a theme is really made of,
 * with the derived tiers and their contrast shown live — the AA discipline
 * the stylesheet documents, made visible at the moment it is being spent.
 */
function Theming() {
  const { t } = useI18n();
  const [stored, setStored] = useState<StoredTheme>(loadStored);

  const pick = (next: StoredTheme) => {
    setStored(next);
    applyTheme(next);
  };

  const isCustom = stored.preset === 'custom';
  const primaries: Primaries =
    isCustom && 'primaries' in stored
      ? stored.primaries
      : {
          bg: currentTheme().colors.bg,
          fg: currentTheme().colors.fg,
          accent: currentTheme().colors.accent,
          ok: currentTheme().colors.ok,
          warn: currentTheme().colors.warn,
          err: currentTheme().colors.err,
        };
  const light = isCustom && 'light' in stored ? stored.light : currentTheme().light;

  const editColor = (key: keyof Primaries, value: string) =>
    pick({ preset: 'custom', light, primaries: { ...primaries, [key]: value } });

  const derived = derive(primaries);
  const checks: { label: string; ratio: number }[] = [
    { label: t('theme.cText'), ratio: contrast(derived.fg, derived.bg) },
    { label: t('theme.cDim'), ratio: contrast(derived.fgDim, derived.bg2) },
    { label: t('theme.cFaint'), ratio: contrast(derived.fgFaint, derived.bg3) },
    { label: t('theme.cAccent'), ratio: contrast(onColor(derived.accent), derived.accent) },
  ];

  return (
    <div data-testid="theming">
      <h3 className="modal-section">{t('env.theme')}</h3>
      <div className="theme-row">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`theme-swatch${stored.preset === p.id ? ' active' : ''}`}
            data-testid={`theme-${p.id}`}
            aria-pressed={stored.preset === p.id}
            style={{
              background: p.colors.bg,
              color: p.colors.fg,
              borderColor: stored.preset === p.id ? p.colors.accent : p.colors.line,
            }}
            onClick={() => pick({ preset: p.id })}
          >
            <span className="swatch-accent" style={{ background: p.colors.accent }} />
            {t(`theme.${p.id}` as 'theme.ink')}
          </button>
        ))}
        <button
          className={`theme-swatch${isCustom ? ' active' : ''}`}
          data-testid="theme-custom"
          aria-pressed={isCustom}
          onClick={() => pick({ preset: 'custom', light, primaries })}
        >
          <span className="swatch-accent" style={{ background: primaries.accent }} />
          {t('theme.custom')}
        </button>
      </div>

      {isCustom && (
        <div className="theme-editor" data-testid="theme-editor">
          <p className="muted small">{t('theme.customHint')}</p>
          <div className="color-grid">
            {COLOR_FIELDS.map(({ key, label }) => (
              <label className="color-field" key={key}>
                {t(label as 'theme.bg')}
                <input
                  type="color"
                  value={primaries[key]}
                  data-testid={`color-${key}`}
                  onChange={(e) => editColor(key, e.target.value)}
                />
              </label>
            ))}
          </div>
          <label className="theme-light">
            <input
              type="checkbox"
              checked={light}
              onChange={(e) => pick({ preset: 'custom', light: e.target.checked, primaries })}
            />
            {t('theme.light')}
          </label>
          {/* The floor the stylesheet promises, checked while it is spent:
              4.5:1 for every text tier, on the surface it actually sits on. */}
          <div className="contrast-chips" data-testid="contrast-chips">
            {checks.map((c) => (
              <span
                key={c.label}
                className={`contrast-chip ${c.ratio >= 4.5 ? 'pass' : 'fail'}`}
              >
                {c.ratio >= 4.5 ? '✓' : <Icon name="warn" />} {c.label} {c.ratio.toFixed(1)}
              </span>
            ))}
          </div>
        </div>
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
