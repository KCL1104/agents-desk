import { useT } from '../i18n';
import { Modal } from './Modal';

/**
 * The keyboard, written down. ⌘/Ctrl+/ opens it — the one shortcut worth
 * memorising is the one that lists the rest. Gestures that live only in
 * tooltips are gestures most people never find.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const rows: [string, string][] = [
    ['⌘/Ctrl + E', t('keys.jump')],
    ['⌘/Ctrl + 1 · 2 · 3', t('keys.views')],
    ['⌘/Ctrl + ⌥/Alt + ← · →', t('keys.cyclePanes')],
    ['Ctrl + PgDn · PgUp', t('keys.cycleTabs')],
    ['⌘/Ctrl + I', t('keys.inspector')],
    ['J · K', t('keys.diff')],
    ['Esc', t('keys.escape')],
    ['⌘/Ctrl + /', t('keys.sheet')],
  ];

  return (
    <Modal onCancel={onClose}>
      <h2>{t('keys.title')}</h2>
      <table className="keys" data-testid="shortcuts">
        <tbody>
          {rows.map(([combo, what]) => (
            <tr key={combo}>
              <td>
                <kbd>{combo}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('keys.shellNote')}</p>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
