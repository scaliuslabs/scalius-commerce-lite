import { useEffect, useSyncExternalStore, type ReactNode } from "react";

/**
 * Light/dark theme. index.html applies the `dark` class before first paint:
 * the merchant's saved choice (localStorage "theme"), otherwise the system
 * preference. This module keeps that class and React in step.
 */
export type Theme = "light" | "dark";
/** What the merchant picked: a fixed theme, or follow the device. */
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "theme";
const listeners = new Set<() => void>();

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
  setThemePreference(theme);
}

/** "system" forgets the saved choice, so the device theme applies again. */
export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  applyTheme(preference === "system" ? systemTheme() : preference);
}

function currentPreference(): ThemePreference {
  return savedTheme() ?? "system";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setTheme: (theme: Theme) => void;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
} {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const preference = useSyncExternalStore(subscribe, currentPreference, () => "system" as ThemePreference);
  return {
    theme,
    preference,
    setTheme,
    setPreference: setThemePreference,
    toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}

/** Follows the system theme until the merchant picks one, and syncs other tabs. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme(savedTheme() ?? systemTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) sync();
    };
    media.addEventListener("change", sync);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return children;
}
