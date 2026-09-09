# Svarla Web — Design Guide

This guide documents the visual language of the Svarla web UI: the design
tokens, color roles, and the conventions to follow when building or changing
components. The goal is a clean, production-grade tool that feels like the same
product as the Svarla Android app.

Everything lives in a single global stylesheet: **`web/src/styles/main.css`**.
Theme behavior lives in **`web/src/theme.ts`**.

---

## Principles

- **Token-first.** Every color, radius, space, and shadow comes from a CSS
  custom property. Never hardcode a hex color in a rule or a component; add or
  reuse a token instead. This is what makes theming (light/dark) a one-place
  change.
- **Restrained, not "Material."** Some rounding, never pill-shaped by default.
  Flat surfaces defined by borders, with shadow reserved for things that
  genuinely float (hover, menus, modals, banners).
- **One product.** The palette mirrors the Android app so the two clients feel
  related. Primary is Svarla purple.
- **Accessible by default.** Visible focus rings, adequate contrast, honored
  motion preferences, and touch-friendly targets on touch devices.

---

## Brand & color

Svarla's brand color is **deep purple `#5b2d90`** (matching the Android app and
the app icon). In dark mode the primary lightens to lavender `#d0bcff` so it
reads on dark surfaces — this is expected, not a second brand color.

### Color roles

Colors are defined as tokens in the `:root` block. Use them by role, not by
appearance:

| Token | Role |
| --- | --- |
| `--md-primary` | Primary actions, active states, links, brand accents |
| `--md-primary-hover` | Hover state for primary buttons |
| `--md-primary-container` | Tinted backgrounds for active/selected items |
| `--md-on-primary` | Text/icons on a primary-colored surface |
| `--md-on-primary-container` | Text/icons on a primary-container surface |
| `--md-secondary` / `-container` | Secondary emphasis |
| `--md-tertiary` (teal) | Accents distinct from primary |
| `--md-surface` | Card / panel / raised backgrounds |
| `--md-surface-dim` | App background (one step below surface) |
| `--md-surface-variant` | Subtle boxed areas (code, endpoints) |
| `--md-surface-container` / `-high` / `-highest` | Layered neutral fills |
| `--md-on-surface` | Primary text |
| `--md-on-surface-variant` | Secondary/muted text, labels |
| `--md-outline` | Standard borders, dividers with weight |
| `--md-outline-variant` | Hairline borders, subtle dividers |
| `--md-error` / `-container` / `--md-on-error*` | Errors, destructive actions |
| `--md-success` / `-container` / `--md-on-success-container` | Success, connected states |
| `--md-warning` / `-container` / `--md-on-warning-container` | Warnings |
| `--md-scrim` | Modal/overlay backdrop |
| `--msg-failed` | Failed-message glyph (sits on the primary-colored bubble) |

Every color token is redefined for dark mode (see **Theming** below), so a rule
that uses tokens works in both themes automatically.

### Provider-number colors are data, not theme

Per-number colors (the colored dots and number badges in conversations and the
numbers page) are **user-chosen data values** stored per provider number. They
are applied inline in the components and default to `#6750A4` to match the
Android fallback. These are intentionally not theme tokens — leave them as-is so
the two clients stay in sync.

---

## Shape (radii)

Rounding is deliberately modest. Tokens (theme-independent):

| Token | Value | Use |
| --- | --- | --- |
| `--md-radius-xs` | 3px | Inline chips, tight corners, bubble tails |
| `--md-radius-sm` | 6px | Inputs, small boxed elements |
| `--md-radius-button` | 6px | **All buttons** |
| `--md-radius-md` | 8px | Cards, list items, nav links, menus |
| `--md-radius-lg` | 10px | Modals, dialogs, login card |
| `--md-radius-xl` | 14px | Large hero surfaces (rare) |
| `--md-radius-full` | 9999px | **Only** dots, avatars, and intentional pills (status badges) |

Rule of thumb: buttons use `--md-radius-button`; containers use `--md-radius-md`
or `--md-radius-lg`. Do not make buttons pill-shaped.

---

## Spacing

An 8px-based scale (with a 4px step for tight cases):

`--md-space-xs` 4 · `--md-space-sm` 8 · `--md-space-md` 16 · `--md-space-lg` 24 ·
`--md-space-xl` 32 · `--md-space-2xl` 48

Use spacing tokens for padding, margins, and gaps rather than literal pixels.

---

## Elevation

Shadows are soft and used **sparingly** — surfaces are flat at rest and defined
by borders. Reach for elevation only when something floats.

| Token | Typical use |
| --- | --- |
| `--md-elevation-1` | Card / list-item hover |
| `--md-elevation-2` | Menus, popovers, login card, dashboard hover |
| `--md-elevation-3` | Snackbars, banners |
| `--md-elevation-4` | Modals and dialogs |

Dark mode redefines these to read as deeper/darker on dark surfaces.

---

## Typography

- **UI font:** Inter (loaded in `index.html`), with a system-font fallback
  stack.
- **Monospace:** `'JetBrains Mono', 'Fira Code', monospace` for phone numbers,
  endpoints, durations, and code.
- Base size 14px, line-height 1.5.
- Headings use `-0.01em`/`-0.02em` letter-spacing and weight 600. Overline-style
  labels (section headers) use uppercase, `0.05em` spacing, and the
  `--md-on-surface-variant` color.

---

## Layout

- `--nav-width: 260px` — sidebar width on desktop (≥768px). Below that the nav
  becomes a top bar with a hamburger menu.
- Content max-widths are set per view (e.g. 700–900px) to keep line lengths
  readable; the shell caps at 1400px on very wide screens.
- Breakpoints in use: 480, 640, 768, 1024, 1280, 1920px.

---

## Controls

- `--control-height: 38px` is the comfortable control height on pointer devices.
- `--min-touch-target: 48px` is applied to interactive elements **only** on
  touch or small screens (`max-width: 640px` or `pointer: coarse`), so desktop
  controls stay compact while touch stays accessible.
- Buttons: primary (filled), `.btn-secondary` (outline), `.btn-danger`,
  `.btn-warning`, `.btn-success-outline`, and `.btn-sm` (compact). Hover shifts
  the background; active nudges 1px down. Buttons do not carry a resting shadow.

---

## Motion

- `--md-motion-ease: cubic-bezier(0.2, 0, 0, 1)`
- `--md-motion-duration-short: 150ms` (hovers, small state changes)
- `--md-motion-duration-medium: 260ms` (entrances: modals, banners, messages)

All motion is disabled under `@media (prefers-reduced-motion: reduce)`.

---

## Theming (light / dark)

Theme is controlled by `web/src/theme.ts`. Three user preferences:

- **`system`** (default) — follows the OS. No `data-theme` attribute is set, so
  the `@media (prefers-color-scheme: dark)` block drives appearance.
- **`light`** / **`dark`** — an explicit choice. Sets `data-theme` on the
  `<html>` element and persists to `localStorage` under `theme-preference`.

The dark palette redefines only the **color** tokens (and elevation/scrim);
shape, spacing, and motion are shared. Both scopes carry the same dark values:

```css
:root[data-theme="dark"] { /* explicit override */ }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { /* OS preference, only when unset */ }
}
```

To prevent a flash of the wrong theme, an inline script in `index.html` sets
`data-theme` before first paint; `initTheme()` in `main.tsx` then wires up
listeners and keeps the `theme-color` meta in sync (`#5b2d90` light /
`#1c1b1f` dark).

The sun/moon toggle lives in the nav header (`nav.tsx`, `ThemeToggle`). It calls
`toggleTheme()`, which collapses `system` into an explicit light/dark choice
based on what is currently shown — the expected behavior for a simple switch.

### Adding or changing a color

1. Add/adjust the token in the `:root` (light) block.
2. Add the matching value in **both** dark scopes.
3. Reference the token in your rule — never a raw hex.

---

## Accessibility checklist

- Use semantic tokens so text keeps adequate contrast in both themes.
- Keep the visible focus ring: `:focus-visible` draws a 2px primary outline.
  Only suppress the ring via `:focus:not(:focus-visible)`.
- Provide `aria-label`/`title` on icon-only controls (see `ThemeToggle`).
- Respect `prefers-reduced-motion` (handled globally — don't add motion that
  can't be disabled).
- Preserve the touch-target sizing on small/touch screens.

> Note: this checklist supports accessibility but is not a substitute for full
> WCAG validation, which requires testing with assistive technologies and expert
> review.

---

## Build

The web UI is a Preact SPA bundled with esbuild via `web/build.ts`
(`npm run build:web`). `main.css` is copied verbatim into `dist/web/` — there is
no CSS preprocessing step, so plain CSS with custom properties is the whole
system.
