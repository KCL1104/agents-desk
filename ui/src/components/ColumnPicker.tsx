import { useT } from '../i18n';
import type { Layout } from '../layout';

const COUNTS = [1, 2, 3];

/**
 * Column count for auto mode, and the way back out of a hand-built layout.
 *
 * `自訂` is not something you can pick — it appears once a drag has given the
 * tab an explicit split tree, and exists so the control still describes what
 * you are looking at. Choosing anything else discards the tree, which is the
 * only undo a hand-built layout has.
 */
export function ColumnPicker({
  layout,
  onPick,
}: {
  layout: Layout;
  onPick: (value: 'auto' | number) => void;
}) {
  const t = useT();
  const manual = layout.mode === 'manual';
  const value = manual ? 'manual' : String(layout.cols);

  return (
    <label className="col-picker">
      <span className="muted small">{t('cols.label')}</span>
      <select
        data-testid="col-picker"
        value={value}
        title={manual ? t('cols.manualHint') : t('cols.autoHint')}
        onChange={(e) => {
          const v = e.target.value;
          onPick(v === 'auto' ? 'auto' : Number(v));
        }}
      >
        {manual && (
          <option value="manual" disabled>
            {t('cols.custom')}
          </option>
        )}
        <option value="auto">{t('cols.auto')}</option>
        {COUNTS.map((n) => (
          <option key={n} value={String(n)}>
            {/* English needs the singular; zh-TW's 欄 never inflects. */}
            {n === 1 ? t('cols.one') : t('cols.n', { n })}
          </option>
        ))}
      </select>
    </label>
  );
}
