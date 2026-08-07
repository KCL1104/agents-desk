import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api } from '../api';

/** base64 -> bytes. The PTY sends bytes so xterm's own UTF-8 decoder can
 *  stitch multi-byte characters that straddle a read boundary. */
export function decodeChunk(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One xterm.js instance bound to one PTY.
 *
 * Attach is a three-step handshake because a PTY starts producing before its
 * pane exists: subscribe first (so nothing is missed), then fetch the replay
 * buffer, then write the buffer followed by only the live chunks newer than
 * the snapshot. Subscribing after the fetch would drop whatever arrived in
 * between; writing both without the sequence check would double it.
 *
 * Every live session keeps its terminal mounted and merely hidden when
 * inactive, so switching tabs preserves scrollback and the TUI never has to
 * repaint from scratch.
 */
export function TerminalView({
  id,
  visible,
  focused = true,
}: {
  id: string;
  visible: boolean;
  /** Only the focused pane takes keystrokes and blinks its cursor. */
  focused?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      // Exactly 1. Anything larger leaves a gap between rows, and a TUI drawn
      // from box characters visibly comes apart at every horizontal rule.
      lineHeight: 1,
      cursorBlink: focused,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: {
        background: '#131316',
        foreground: '#e7e7ea',
        cursor: '#7aa2f7',
        selectionBackground: '#2f3b54',
        black: '#1d1d22',
        brightBlack: '#5a5a66',
        red: '#e06c75',
        brightRed: '#ff7b86',
        green: '#79c08a',
        brightGreen: '#8fd6a0',
        yellow: '#e0af68',
        brightYellow: '#f0c584',
        blue: '#7aa2f7',
        brightBlue: '#93b6ff',
        magenta: '#bb9af7',
        brightMagenta: '#d0b4ff',
        cyan: '#56b6c2',
        brightCyan: '#6fd3e0',
        white: '#c8c8d0',
        brightWhite: '#ffffff',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // WebGL keeps a redraw-heavy TUI smooth, but WKWebView drops the context
    // more readily than Chromium does, and a dropped context paints a torn,
    // half-stale frame. Dispose on loss so xterm falls back to its DOM
    // renderer, which is slower and correct.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('[term] WebGL context lost; falling back to the DOM renderer');
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer is fine */
    }

    termRef.current = term;
    fitRef.current = fit;
    // Test seam. The WebGL renderer leaves the DOM row layer empty, so an
    // end-to-end check of what is on screen has to read the buffer.
    (host as HTMLDivElement & { __term?: Terminal }).__term = term;

    // Step 1: subscribe, holding chunks until the snapshot decides which of
    // them are already included in it.
    let pending: Array<{ seq: number; data: string }> | null = [];
    const unlistenPromise = api.onTermOutput(id, (data, seq) => {
      if (disposed) return;
      if (pending) pending.push({ seq, data });
      else term.write(decodeChunk(data));
    });

    // Steps 2 and 3.
    void (async () => {
      let snapshotSeq = 0;
      try {
        const snap = await api.termSnapshot(id);
        if (disposed) return;
        if (snap.data) term.write(decodeChunk(snap.data));
        snapshotSeq = snap.seq;
      } catch {
        // No replay available (an older session, or the PTY is gone). Live
        // output alone is still better than nothing.
      }
      const queued = pending ?? [];
      pending = null;
      for (const chunk of queued) {
        if (chunk.seq > snapshotSeq) term.write(decodeChunk(chunk.data));
      }
    })();

    const pushSize = () => {
      // A hidden pane has no layout, so fit() would compute a nonsense size
      // and resize the PTY on the agent's behalf.
      if (host.offsetParent === null) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      void api.termResize(id, term.cols, term.rows);
    };
    pushSize();

    // Dragging a splitter changes this pane's size on every frame. Each
    // termResize is a SIGWINCH the agent answers by reflowing its whole TUI,
    // so telling it 60 times a second makes a drag unusable. The DOM keeps up
    // with the cursor; the PTY hears about it once the drag settles.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(settle);
      settle = setTimeout(pushSize, 80);
    };

    const onData = term.onData((data) => void api.termWrite(id, data));
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    return () => {
      disposed = true;
      clearTimeout(settle);
      observer.disconnect();
      onData.dispose();
      void unlistenPromise.then((off) => off());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  // Refit on reveal: xterm cannot measure a display:none element. Only the
  // focused pane takes the caret, so keystrokes cannot land in the wrong
  // terminal when several are on screen.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
      void api.termResize(id, term.cols, term.rows);
      if (focused) term.focus();
      else term.blur();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, focused, id]);

  // A blinking cursor repaints forever. With four panes on screen only the
  // focused one should be doing that. (xterm already batches writes on its
  // own animation frame, so a second coalescer here would buy nothing.)
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.cursorBlink = focused;
  }, [focused]);

  return (
    <div
      className="term-host"
      ref={hostRef}
      data-session-id={id}
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
