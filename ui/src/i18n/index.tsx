import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { translator, type Locale, type MessageKey, type TFn } from './messages';

export type { MessageKey, Locale, TFn };
export { translator } from './messages';

export const LOCALES: readonly Locale[] = ['en', 'zh-TW'];

/** Each language named in itself — a picker that says "Chinese" in English is
    no use to someone who cannot read the current language. */
export const LOCALE_NAME: Record<Locale, string> = {
  en: 'English',
  'zh-TW': '繁體中文',
};

const STORAGE_KEY = 'marol.locale';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'zh-TW';
}

/**
 * The language to open in.
 *
 * A stored choice always wins — it is the one thing the user said out loud.
 * Otherwise any Chinese system locale gets Chinese and everything else gets
 * English, which is the honest default for a two-language catalogue.
 */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Private-mode webviews can throw on storage access. Fall through to the
    // system locale rather than failing to render at all.
  }
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.toLowerCase().startsWith('zh')) return 'zh-TW';
  }
  return 'en';
}

interface I18nValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Notifies the Rust side so native notifications match the interface.
 *
 * Deliberately fire-and-forget and deliberately not imported from `api.ts`:
 * the language must still switch in the browser-based Playwright run, where
 * that command is not mocked, and a rejected promise there would be noise.
 */
async function pushLocaleToBackend(locale: Locale): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_locale', { locale });
  } catch {
    // No backend (tests, or a build without the command). The interface is
    // already translated; only the native notification text is affected.
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  // Tell the backend the starting language too, not just the changes — a user
  // whose system is Chinese and who never touches the picker still expects
  // Chinese notifications.
  useEffect(() => {
    void pushLocaleToBackend(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice is survivable; refusing to
      // switch is not.
    }
  }, []);

  const t = useMemo<TFn>(() => translator(locale), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** The common case: a component that only needs to say things. */
export function useT(): TFn {
  return useI18n().t;
}
