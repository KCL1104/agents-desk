import { useEffect, useId, useRef } from 'react';
import type * as React from 'react';

interface Props {
  onCancel: () => void;
  /**
   * Typed content is at stake. A dirty dialog ignores backdrop clicks — a
   * stray click must not discard someone's prompt — but Escape still closes:
   * it is deliberate in a way a mis-aimed click is not.
   */
  dirty?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The one modal wrapper, so every dialog behaves like a dialog.
 *
 * Escape closes. Focus starts inside and stays inside — Tab from the last
 * control wraps to the first instead of walking off into the obscured board
 * behind the backdrop — and goes back where it was when the dialog closes.
 */
export function Modal({ onCancel, dirty = false, wide = false, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const titleId = useId();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Every dialog opens with an <h2>; wiring it up is what turns an
    // anonymous "dialog" announcement into "開始 attempt, dialog".
    el.querySelector('h2')?.setAttribute('id', titleId);
    const before = document.activeElement as HTMLElement | null;
    // Land on the first control unless something inside (autoFocus) beat us.
    if (!el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    // On the document, not the React tree: a click on the backdrop parks
    // focus on <body>, and keys pressed there still belong to the dialog —
    // it is modal, nothing behind it should hear the keyboard.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={dirty ? undefined : onCancel}>
      <div
        ref={box}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
