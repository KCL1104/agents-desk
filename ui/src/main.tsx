import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import { applyTheme, loadStored } from './theme';
// The product's voice for data — branches, paths, stats, and the
// terminals themselves. Self-hosted (OFL), latin only: CJK falls through
// to the system stack, and the mono layer is ASCII-heavy by nature.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

// Before the first paint, so a saved theme never flashes the default one.
applyTheme(loadStored());

// xterm measures its cell grid from the font that is loaded at open. The
// face is a local woff2 — milliseconds — but a terminal measured against
// the fallback and repainted in Plex would tear its own grid, so the
// mount waits for the font (bounded: past 500ms, fallback metrics win).
const ready = Promise.race([
  document.fonts.load('13px "IBM Plex Mono"').catch(() => undefined),
  new Promise((r) => setTimeout(r, 500)),
]);

void ready.then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
});
