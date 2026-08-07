import { useCallback, useRef, useState } from 'react';
import type * as React from 'react';
import { TerminalView } from './TerminalView';
import {
  decodeDrag,
  DRAG_MIME,
  encodeDrag,
  previewInset,
  zoneAt,
  type DragPayload,
  type Zone,
} from '../layout';
import type { SessionMeta } from '../types';

/**
 * Drop-target plumbing, shared by the pane and the empty grid.
 *
 * `dragleave` fires whenever the cursor crosses into a child element, so a
 * naive boolean flickers off the moment you move over the terminal inside the
 * pane. Counting enter/leave pairs keeps the highlight steady.
 *
 * The zone is recomputed on every `dragover` because it is what tells the user
 * whether they are about to swap or to split, and in which direction.
 */
function useDropTarget(onDrop: (p: DragPayload, zone: Zone) => void, zoned = true) {
  const depth = useRef(0);
  const [zone, setZone] = useState<Zone | null>(null);

  const readZone = (e: React.DragEvent): Zone => {
    if (!zoned) return 'center';
    const r = e.currentTarget.getBoundingClientRect();
    return zoneAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };

  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      depth.current += 1;
      setZone(readZone(e));
    },
    onDragOver: (e: React.DragEvent) => {
      // Without preventDefault the browser refuses the drop entirely.
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setZone(readZone(e));
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setZone(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const where = readZone(e);
      depth.current = 0;
      setZone(null);
      const payload = decodeDrag(e.dataTransfer.getData(DRAG_MIME));
      if (payload) onDrop(payload, where);
    },
  };

  return { zone, handlers };
}

interface PaneProps {
  session: SessionMeta;
  focused: boolean;
  visible: boolean;
  zoomed: boolean;
  style?: React.CSSProperties;
  onFocus: () => void;
  onToggleZoom: () => void;
  onDrop: (payload: DragPayload, zone: Zone) => void;
  onEject: () => void;
}

/**
 * One pane: a header and the terminal under it.
 *
 * The header exists for two reasons. In a multi-pane layout the TUI alone does
 * not tell you which repo a pane belongs to, and dragging needs a handle that
 * is not the terminal — xterm claims mouse events for text selection, so
 * starting a drag on the terminal body would fight it.
 */
export function Pane({
  session,
  focused,
  visible,
  zoomed,
  style,
  onFocus,
  onToggleZoom,
  onDrop,
  onEject,
}: PaneProps) {
  const { zone, handlers } = useDropTarget(onDrop);

  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, encodeDrag({ kind: 'pane', id: session.id }));
      e.dataTransfer.effectAllowed = 'move';
    },
    [session.id],
  );

  return (
    <div
      className={`pane${focused ? ' focused' : ''}${zone ? ' drop-over' : ''}${
        zoomed ? ' zoomed' : ''
      }`}
      style={{ ...style, display: visible ? 'flex' : 'none' }}
      data-testid={`pane-${session.id}`}
      data-session-id={session.id}
      onMouseDown={onFocus}
      {...handlers}
    >
      <div
        className="pane-head"
        draggable
        onDragStart={onDragStart}
        onDoubleClick={onToggleZoom}
        title="拖到別的 pane 中央可對調，拖到邊緣可切分；雙擊放大"
      >
        <span className={`dot ${session.status}`} />
        <span className="pane-title">{basename(session.cwd)}</span>
        <span className="pane-agent mono">{session.agent}</span>
        <button
          className="pane-zoom"
          title={zoomed ? '還原' : '放大到滿版'}
          data-testid={`zoom-${session.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleZoom();
          }}
        >
          {zoomed ? '⤡' : '⤢'}
        </button>
        <button
          className="pane-eject"
          title="從佈局移除（session 繼續執行）"
          data-testid={`eject-${session.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onEject();
          }}
        >
          ✕
        </button>
      </div>
      <TerminalView id={session.id} visible={visible} focused={focused} />

      {/* Which half lights up is the only signal that says "this will split
          here" rather than "this will swap". */}
      {zone && (
        <div
          className={`drop-preview${zone === 'center' ? ' swap' : ''}`}
          data-testid={`drop-${session.id}`}
          data-zone={zone}
          style={previewInset(zone)}
        />
      )}
    </div>
  );
}

/**
 * A strip along one side of the whole layout.
 *
 * These only exist while something is being dragged, so they never sit in
 * front of a terminal you are trying to click. They overlay the outer edge of
 * whichever panes are there, which is the point: the outermost band splits the
 * layout, the band just inside it splits the pane.
 */
export function EdgeDrop({
  zone,
  onDrop,
}: {
  zone: Exclude<Zone, 'center'>;
  onDrop: (payload: DragPayload, zone: Zone) => void;
}) {
  const { zone: over, handlers } = useDropTarget((p) => onDrop(p, zone), false);

  return (
    <div
      className={`edge-drop ${zone}${over ? ' drop-over' : ''}`}
      data-testid={`edge-${zone}`}
      {...handlers}
    />
  );
}

/** The whole grid when a tab holds nothing yet, and a drop target for it. */
export function EmptyGrid({ onDrop }: { onDrop: (payload: DragPayload) => void }) {
  const { zone, handlers } = useDropTarget((p) => onDrop(p), false);

  return (
    <div
      className={`term-empty${zone ? ' drop-over' : ''}`}
      data-testid="empty-grid"
      {...handlers}
    >
      <p className="muted small">把 session 從左側拖進來，或直接點選</p>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
