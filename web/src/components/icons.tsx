import { h, Fragment } from "preact";
import type { ComponentChildren } from "preact";

/**
 * Material-style outline icons rendered as inline SVG so they inherit the
 * current text color and stay pixel-consistent (instead of a mix of unicode
 * glyphs). All share a 24px viewBox and 1.75 stroke weight — the same
 * convention used by the Settings page and the Call History list.
 *
 * `size` defaults to 20 to match the settings tabs / call list; the dashboard
 * cards render at a larger size via the `size` prop.
 */
export function iconSvg(children: ComponentChildren, size = 20) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Solid-fill variant for glyphs that only read correctly as a filled shape
 * (e.g. Material's `call_end`, which the Android app uses for decline/hang-up).
 * Fills with `currentColor` so it still inherits the button's text color.
 */
export function iconSvgFilled(children: ComponentChildren, size = 20) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Home — the Dashboard. */
export function homeIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </Fragment>,
    size
  );
}

/** Speech bubble — SMS conversations. Matches the message action icon. */
export function chatIcon(size?: number) {
  return iconSvg(
    <path d="M21 11.5a8.5 8.5 0 0 1-11.9 7.8L3 21l1.7-6.1A8.5 8.5 0 1 1 21 11.5z" />,
    size
  );
}

/** Up-right arrow into the corner — call activity. Mirrors the outbound call glyph. */
export function callIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </Fragment>,
    size
  );
}

/** Gear — Settings. */
export function settingsIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Fragment>,
    size
  );
}

/** Tray with a down arrow — download the Android app. */
export function downloadIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M12 4v10" />
      <path d="M8 11l4 3 4-3" />
      <path d="M5 19h14" />
    </Fragment>,
    size
  );
}
/** Handset — place/answer a call. Replaces the old 📞 glyph on call surfaces. */
export function phoneIcon(size?: number) {
  return iconSvg(
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />,
    size
  );
}

/**
 * Hang up / decline a call. This is Material's `call_end` glyph — the tilted
 * handset with signal arcs — matching the Android app, which uses
 * `Icons.Default.CallEnd` for both Decline and End-call. Rendered filled (like
 * Material's baseline icon) since the shape only reads as a hang-up button when
 * solid.
 */
export function phoneOffIcon(size?: number) {
  return iconSvgFilled(
    <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />,
    size
  );
}

/** Microphone — mic active / unmuted. */
export function micIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </Fragment>,
    size
  );
}

/** Microphone with a strike-through — muted. */
export function micOffIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M9 9V6a3 3 0 0 1 5.12-2.12" />
      <path d="M15 9.34V11a3 3 0 0 1-4.5 2.6" />
      <path d="M5 11a7 7 0 0 0 10.9 5.8" />
      <path d="M19 11a7 7 0 0 1-.5 2.6" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
      <path d="M3 3l18 18" />
    </Fragment>,
    size
  );
}

/** 3x4 grid of dots — the DTMF keypad. */
export function dialpadIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <circle cx="7" cy="6" r="0.5" />
      <circle cx="12" cy="6" r="0.5" />
      <circle cx="17" cy="6" r="0.5" />
      <circle cx="7" cy="11" r="0.5" />
      <circle cx="12" cy="11" r="0.5" />
      <circle cx="17" cy="11" r="0.5" />
      <circle cx="7" cy="16" r="0.5" />
      <circle cx="12" cy="16" r="0.5" />
      <circle cx="17" cy="16" r="0.5" />
      <circle cx="12" cy="21" r="0.5" />
    </Fragment>,
    size
  );
}

/** Speaker with sound waves — call volume. */
export function volumeIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a8 8 0 0 1 0 12" />
    </Fragment>,
    size
  );
}

/** Left arrow — back navigation. Matches the app's outline icon style. */
export function backIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </Fragment>,
    size
  );
}

/** Backspace — delete the last dialed digit. Matches the Android dial pad's backspace key. */
export function backspaceIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M21 5H8L2 12l6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" />
      <path d="M15 9l-5 6" />
      <path d="M10 9l5 6" />
    </Fragment>,
    size
  );
}

/** Trash can — delete/remove. Matches the app's outline icon style. */
export function trashIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Fragment>,
    size
  );
}
