import { useT, type MessageKey } from '../i18n';

/**
 * The refusals the core is known to make, translated into what to do about
 * them. The backend speaks precise English; a person mid-dialog needs the
 * next step in their own language, with the raw text one disclosure away.
 * Anything unrecognized passes through verbatim — an unknown failure
 * paraphrased is worse than an unknown failure quoted.
 */
const KNOWN: { re: RegExp; key: MessageKey }[] = [
  { re: /^(.+) is not a directory$/, key: 'err.notDir' },
  { re: /^(.+) is not a git repository$/, key: 'err.notGitRepo' },
  { re: /^(.+) has no branch `(.+)`$/, key: 'err.noBranch' },
];

export function explainError(raw: string): { key: MessageKey; params: Record<string, string> } | null {
  const text = raw.replace(/^Error:\s*/, '').trim();
  for (const { re, key } of KNOWN) {
    const m = text.match(re);
    if (m) return { key, params: { path: m[1] ?? '', branch: m[2] ?? '' } };
  }
  return null;
}

export function FriendlyError({ text, testid }: { text: string; testid: string }) {
  const t = useT();
  const known = explainError(text);

  if (!known) {
    return (
      <p className="dialog-error" role="alert" data-testid={testid}>
        {text}
      </p>
    );
  }
  return (
    <div className="dialog-error" role="alert" data-testid={testid}>
      {t(known.key, known.params)}
      <details className="err-details">
        <summary>{t('err.details')}</summary>
        <span className="mono">{text}</span>
      </details>
    </div>
  );
}
