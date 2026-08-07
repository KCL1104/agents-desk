import { useLayoutEffect, useState } from 'react';

/**
 * The element's content box, tracked live.
 *
 * Auto mode needs the width to decide how many columns fit, and manual mode
 * needs both dimensions to turn its split tree into rectangles. Both have to
 * react to the window being resized, so neither can read the size once.
 *
 * The element arrives through a callback ref rather than a `useRef`. The grid
 * is not rendered while the app is still booting, so a `useRef` would be null
 * on mount — and an effect keyed on `[]` would have already run and given up
 * by the time the element appeared, leaving the layout stuck at zero width.
 */
export function useSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!el) return;

    const read = () => {
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setSize((cur) => {
        const w = Math.max(0, el.clientWidth - padX);
        const h = Math.max(0, el.clientHeight - padY);
        // Bail on no-op writes: this fires on every frame of a splitter drag,
        // and a fresh object each time would rerender the whole grid.
        return cur.w === w && cur.h === h ? cur : { w, h };
      });
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [setEl, size] as const;
}
