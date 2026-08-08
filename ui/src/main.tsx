import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import { applyTheme, loadStored } from './theme';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

// Before the first paint, so a saved theme never flashes the default one.
applyTheme(loadStored());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
