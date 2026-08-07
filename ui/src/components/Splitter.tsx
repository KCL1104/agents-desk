import { useRef } from 'react';
import type * as React from 'react';
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

  return (
    <div
      className={`splitter ${handle.dir}`}
      role="separator"
      aria-orientation={handle.dir === 'row' ? 'vertical' : 'horizontal'}
      data-testid={`splitter-${handle.path.join('.') || 'root'}-${handle.index}`}
      title="拖曳調整比例；雙擊還原等分"
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
      onDoubleClick={() => onReset(handle.path)}
    />
  );
}
