import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'sindral-theme';
const COOKIE_KEY = 'sindral_theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: string | null | undefined): value is Theme {
  return value === 'dark' || value === 'light';
}

function preferredTheme(): Theme {
  if (typeof document !== 'undefined' && isTheme(document.documentElement.dataset.theme)) return document.documentElement.dataset.theme;
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isTheme(stored)) return stored;
    } catch {
      // Fall through to cookie/system preference.
    }
  }
  if (typeof document !== 'undefined') {
    const cookieTheme = document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${COOKIE_KEY}=`))
      ?.split('=')[1];
    if (isTheme(cookieTheme)) return cookieTheme;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'light' ? 'light dark' : 'dark light');
}

function persistTheme(theme: Theme) {
  applyTheme(theme);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${COOKIE_KEY}=${theme}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(preferredTheme);

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (nextTheme) => {
        persistTheme(nextTheme);
        setThemeState(nextTheme);
      },
      toggleTheme: () =>
        setThemeState((current) => {
          const nextTheme = current === 'light' ? 'dark' : 'light';
          persistTheme(nextTheme);
          return nextTheme;
        }),
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
