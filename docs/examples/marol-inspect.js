/**
 * Marol inspect — the repo's half of the preview's one channel.
 *
 * Load this in your dev server's page (dev builds only), and Alt+click
 * turns any element into a message the Marol preview panel can hear:
 * which component, which file, which line. The desk composes it into a
 * sentence for the agent; sending stays a human click.
 *
 * Vite:   put this file somewhere in your app and, in dev only:
 *           if (import.meta.env.DEV) import('./marol-inspect.js');
 * Plain:  <script src="/marol-inspect.js"></script> in the dev html.
 *
 * Nothing here runs in production builds unless you ship it there, and
 * Marol never injects it for you — that is the point. The desk only
 * listens for `marol:pick` from the page it is previewing.
 */
(() => {
  /** React dev builds hang the source on the fiber; Vue on the vnode. */
  function sourceOf(el) {
    for (let node = el; node; node = node.parentElement) {
      const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      if (fiberKey) {
        for (let f = node[fiberKey]; f; f = f.return) {
          const src = f._debugSource;
          if (src && src.fileName) {
            const name =
              (f.type && (f.type.displayName || f.type.name)) ||
              (typeof f.elementType === 'function' && f.elementType.name) ||
              node.tagName.toLowerCase();
            return { component: String(name), file: src.fileName, line: src.lineNumber || 0 };
          }
        }
      }
      const vue = node.__vueParentComponent;
      if (vue && vue.type && vue.type.__file) {
        return {
          component: vue.type.name || vue.type.__name || node.tagName.toLowerCase(),
          file: vue.type.__file,
          line: 0,
        };
      }
    }
    return null;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!e.altKey) return;
      const picked = sourceOf(e.target);
      if (!picked) return;
      e.preventDefault();
      e.stopPropagation();
      // The parent is the Marol preview panel when there is one, and
      // nothing otherwise — '*' is fine because the payload holds no secret
      // and the desk verifies the *sender's* origin on its side.
      window.parent.postMessage({ type: 'marol:pick', ...picked }, '*');
    },
    true,
  );
})();
