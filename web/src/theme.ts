/**
 * Theme controller.
 *
 * Manages the light/dark appearance of the web UI. Three user preferences
 * are supported:
 *   - "system": follow the OS (no data-theme attribute; CSS media query drives it)
 *   - "light":  force light
 *   - "dark":   force dark
 *
 * The preference is persisted to localStorage. The effective (resolved)
 * theme is exposed for UI that needs to reflect the current appearance,
 * such as the sun/moon toggle in the nav header.
 *
 * See web/src/styles/main.css for the token definitions each theme uses.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme-preference";

// theme-color meta values, kept in sync with the CSS surface tokens.
const THEME_COLOR_LIGHT = "#5b2d90";
const THEME_COLOR_DARK = "#1c1b1f";

type Listener = (resolved: ResolvedTheme, preference: ThemePreference) => void;

const listeners = new Set<Listener>();
const darkMediaQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall back to system.
  }
  return "system";
}

/** The user's stored preference. */
export function getThemePreference(): ThemePreference {
  return readStoredPreference();
}

/** Resolve a preference to the theme actually shown on screen. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") {
    return darkMediaQuery?.matches ? "dark" : "light";
  }
  return preference;
}

/** The theme currently rendered (accounts for system preference). */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(getThemePreference());
}

function updateThemeColorMeta(resolved: ResolvedTheme): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      "content",
      resolved === "dark" ? THEME_COLOR_DARK : THEME_COLOR_LIGHT
    );
  }
}

/**
 * Apply a preference: set (or clear) the data-theme attribute on <html>,
 * update the theme-color meta, and notify subscribers.
 */
function apply(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
  const resolved = resolveTheme(preference);
  updateThemeColorMeta(resolved);
  for (const listener of listeners) {
    listener(resolved, preference);
  }
}

/** Persist and apply a new preference. */
export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // Ignore storage failures — the in-memory application still works.
  }
  apply(preference);
}

/**
 * Toggle between light and dark based on what is currently shown.
 * This collapses "system" into an explicit choice, which is the expected
 * behavior for a simple sun/moon switch.
 */
export function toggleTheme(): void {
  setThemePreference(getResolvedTheme() === "dark" ? "light" : "dark");
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Initialize the theme on startup. Applies the stored preference and, while
 * the preference is "system", keeps the UI in sync with OS changes.
 * Safe to call once at app boot.
 */
export function initTheme(): void {
  apply(getThemePreference());

  darkMediaQuery?.addEventListener("change", () => {
    // Only react to OS changes when following the system.
    if (getThemePreference() === "system") {
      const resolved = getResolvedTheme();
      updateThemeColorMeta(resolved);
      for (const listener of listeners) {
        listener(resolved, "system");
      }
    }
  });
}
