import { useRef } from 'react';
import type * as React from 'react';
import { useT } from '../i18n';
import { dragHandle, type Handle } from '../layout';

/**
 * The draggable boundary between two panes of one split.
 *
 * Dragging updates the layout live but only writes it to the tab on release.
 * The intermediate values are worth nothing once the drag is over, and
 * persisting each one would mean a database round trip per animation frame.
 *
 * Pointer capture is what makes the drag survive the cursor crossing over a
 * terminal: without it the pane underneath starts receiving the moves and the
 * splitter stops tracking halfway through.
 */
export function Splitter({
  handle,
  fr,
  onPreview,
  onCommit,
  onReset,
}: {
  handle: Handle;
  fr: readonly number[];
  onPreview: (path: number[], fr: number[]) => void;
  onCommit: (path: number[], fr: number[]) => void;
  onReset: (path: number[]) => void;
}) {
  const t = useT();
  const drag = useRef<{ from: number; fr: number[] } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      from: handle.dir === 'row' ? e.clientX : e.clientY,
      fr: [...fr],
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const now = handle.dir === 'row' ? e.clientX : e.clientY;
    onPreview(handle.path, dragHandle(d.fr, handle.index, now - d.from, handle.span));
  };

  const finish = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const now = handle.dir === 'row' ? e.clientX : e.clientY;
    onCommit(handle.path, dragHandle(d.fr, handle.index, now - d.from, handle.span));
  };

  /** role="separator" promises keyboard adjustability; kept, like the
   *  drawer's grip: arrows nudge by a keystroke's worth of pixels through
   *  the same clamping the drag goes through, committed immediately —
   *  there is no release to wait for. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const along =
      handle.dir === 'row'
        ? { grow: 'ArrowRight', shrink: 'ArrowLeft' }
        : { grow: 'ArrowDown', shrink: 'ArrowUp' };
    if (e.key !== along.grow && e.key !== along.shrink) return;
    e.preventDefault();
    const delta = e.key === along.grow ? 24 : -24;
    onCommit(handle.path, dragHandle([...fr], handle.index, delta, handle.span));
  };

  // aria-valuenow 用百分比（0–100）：前一格佔這對鄰居的比例。fr 是相對
  // 值、像素隨視窗變，百分比才是拖曳與方向鍵都說得通的同一種單位 ——
  // 兩條路都經過 App 的 state 再流回 fr prop，所以數字自己會跟上。
  const pair = fr[handle.index] + fr[handle.index + 1];
  const valueNow = pair > 0 ? Math.round((fr[handle.index] / pair) * 100) : 50;

  return (
    <div
      className={`splitter ${handle.dir}`}
      role="separator"
      aria-orientation={handle.dir === 'row' ? 'vertical' : 'horizontal'}
      aria-label={t('gesture.splitter')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valueNow}
      tabIndex={0}
      data-testid={`splitter-${handle.path.join('.') || 'root'}-${handle.index}`}
      title={t('splitter.hint')}
      style={{
        left: handle.rect.x,
        top: handle.rect.y,
        width: handle.rect.w,
        height: handle.rect.h,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onReset(handle.path)}
    />
  );
}
