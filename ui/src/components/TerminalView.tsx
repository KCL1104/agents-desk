import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api } from '../api';
import { useT } from '../i18n';
import { xtermTheme } from '../theme';

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
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  /** The find bar, and whether the last search came up empty — the input
      wears that state rather than failing silently. */
  const [finding, setFinding] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      // The product's own mono. main.tsx holds the mount until this face
      // is loaded, so the cell grid is measured against the real metrics.
      fontFamily:
        '"IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      // Exactly 1. Anything larger leaves a gap between rows, and a TUI drawn
      // from box characters visibly comes apart at every horizontal rule.
      lineHeight: 1,
      cursorBlink: focused,
      allowProposedApi: true,
      scrollback: 10_000,
      // The terminal wears the app's theme: same background, same accent
      // for the cursor, an ANSI ramp picked for the theme's polarity.
      theme: xtermTheme(),
    });

    // Re-paint when the theme changes — every terminal stays mounted for
    // its scrollback, so a theme switch must reach the ones already open.
    const onTheme = () => {
      term.options.theme = xtermTheme();
    };
    window.addEventListener('agentdesk:theme', onTheme);

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // WebGL is loaded per *visibility*, not here — see the effect below.
    // Search rides the whole scrollback; links open in the browser on
    // ⌘/Ctrl+click only, because a plain click belongs to the TUI's own
    // mouse protocol and to text selection.
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) void api.openExternal(uri);
      }),
    );

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
    // A "no match" verdict describes the buffer at the moment of the
    // search; new output makes it stale, and a red box that outlives its
    // truth teaches people to ignore it.
    const onWrote = term.onWriteParsed(() => setNoMatch(false));
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    return () => {
      disposed = true;
      clearTimeout(settle);
      window.removeEventListener('agentdesk:theme', onTheme);
      observer.disconnect();
      onData.dispose();
      onWrote.dispose();
      void unlistenPromise.then((off) => off());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [id]);

  // WebGL rides visibility. Measured (Chromium): creating a context never
  // fails — the browser silently kills the *oldest* once more than 16 are
  // alive. Every live session keeps its terminal mounted, so contexts held
  // by hidden panes would evict the very panes on screen. Visible panes
  // are bounded by the layout; hidden ones render nothing and need nothing.
  // A context lost anyway (WKWebView sheds them under memory pressure)
  // falls back to the DOM renderer and heals on the next reveal.
  useEffect(() => {
    const term = termRef.current;
    if (!visible || !term) return;
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        console.warn('[term] WebGL context lost; falling back to the DOM renderer');
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer is fine */
    }
    return () => {
      // Also runs at unmount, possibly after term.dispose() has already
      // taken the addon with it — disposing twice must stay a no-op.
      try {
        webgl?.dispose();
      } catch {
        /* already gone with the terminal */
      }
    };
  }, [visible, id]);

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

  // ⌘/Ctrl+F, routed by the App's one keyboard table: the event names
  // which pane, this pane answers only to its own name — the theme
  // event's precedent for talking to components that are not in the
  // prop chain.
  useEffect(() => {
    const onFind = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setFinding(true);
      // Already open: the chord means "put the caret back in the box".
      findInputRef.current?.focus();
    };
    window.addEventListener('agentdesk:find', onFind);
    return () => window.removeEventListener('agentdesk:find', onFind);
  }, [id]);

  useEffect(() => {
    if (finding) findInputRef.current?.focus();
  }, [finding]);

  const closeFind = () => {
    setFinding(false);
    setNoMatch(false);
    termRef.current?.focus();
  };

  const findStep = (q: string, forward: boolean) => {
    if (q === '' || searchRef.current === null) return;
    const hit = forward ? searchRef.current.findNext(q) : searchRef.current.findPrevious(q);
    // "Not found" as a worn state, not a silent shrug — the input turns
    // and the tooltip says why.
    setNoMatch(!hit);
  };

  return (
    <div
      className="term-host"
      ref={hostRef}
      data-session-id={id}
      style={{ display: visible ? 'block' : 'none' }}
    >
      {finding && (
        <div className="term-find" data-testid={`term-find-${id}`}>
          <input
            ref={findInputRef}
            className={`mono${noMatch ? ' no-match' : ''}`}
            placeholder={t('term.find')}
            aria-label={t('term.find')}
            aria-invalid={noMatch || undefined}
            title={noMatch ? t('term.noMatch') : t('term.findHint')}
            data-testid={`term-find-input-${id}`}
            onChange={() => setNoMatch(false)}
            onKeyDown={(e) => {
              // The bar owns its keys; the terminal under it must not
              // hear them, nor any global Esc listener above.
              e.stopPropagation();
              if (e.key === 'Enter') {
                findStep(e.currentTarget.value, !e.shiftKey);
              } else if (e.key === 'Escape') {
                closeFind();
              }
            }}
          />
          {/* The stepping the tooltip promises, standing where it can be
              seen: Enter and these are the same two moves. */}
          <button
            className="icon"
            aria-label={t('term.prev')}
            title={t('term.prev')}
            onClick={() => findStep(findInputRef.current?.value ?? '', false)}
          >
            ‹
          </button>
          <button
            className="icon"
            aria-label={t('term.next')}
            title={t('term.next')}
            onClick={() => findStep(findInputRef.current?.value ?? '', true)}
          >
            ›
          </button>
          <button
            className="icon"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={closeFind}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
