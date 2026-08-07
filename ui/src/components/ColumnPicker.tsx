import type { Layout } from '../layout';

const CHOICES = [
  { value: 'auto', label: '自動' },
  { value: '1', label: '1 欄' },
  { value: '2', label: '2 欄' },
  { value: '3', label: '3 欄' },
];

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
  const manual = layout.mode === 'manual';
  const value = manual ? 'manual' : String(layout.cols);

  return (
    <label className="col-picker">
      <span className="muted small">欄數</span>
      <select
        data-testid="col-picker"
        value={value}
        title={manual ? '這個分頁的佈局是你自己排的；選其他值會還原成自動' : '依視窗寬度自動決定欄數'}
        onChange={(e) => {
          const v = e.target.value;
          onPick(v === 'auto' ? 'auto' : Number(v));
        }}
      >
        {manual && (
          <option value="manual" disabled>
            自訂
          </option>
        )}
        {CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
