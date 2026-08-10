import { useT } from '../i18n';
import { COACH_KEY, type CoachId } from '../coach';
import { chord } from '../platform';

/**
 * The card a coaching moment appears on.
 *
 * Non-modal and never focus-stealing — the person may be mid-keystroke in
 * a terminal, and a teaching aid that interrupts the thing it teaches has
 * taught the wrong lesson. It sits in one fixed corner so the eye learns
 * where coaching lives, announces politely to AT, and offers exactly one
 * action: acknowledging it, which is also what retires it for good.
 */
export function CoachMark({ id, onDismiss }: { id: CoachId; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className="coach" role="status" data-testid={`coach-${id}`}>
      <strong className="coach-title">{t(COACH_KEY[id].title)}</strong>
      {/* {jump} 依平台代入(⌘E / Ctrl+E)—— 沒有這個佔位符的內文
          不受影響:t() 只替換模板裡真的存在的名字。 */}
      <p className="coach-body">{t(COACH_KEY[id].body, { jump: chord('E') })}</p>
      <button data-testid="coach-dismiss" onClick={onDismiss}>
        {t('coach.gotIt')}
      </button>
    </div>
  );
}
