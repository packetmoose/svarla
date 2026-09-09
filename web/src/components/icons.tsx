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
    <path d="M6.5 3.5 9 3l1.5 4-2 1.5a12 12 0 0 0 5 5l1.5-2 4 1.5-.5 2.5A2 2 0 0 1 21 17a17 17 0 0 1-15-15 2 2 0 0 1 .5-1.5z" />,
    size
  );
}

/** Handset with a strike-through — hang up / decline a call. */
export function phoneOffIcon(size?: number) {
  return iconSvg(
    <Fragment>
      <path d="M6.5 3.5 9 3l1.5 4-2 1.5a12 12 0 0 0 5 5l1.5-2 4 1.5-.5 2.5A2 2 0 0 1 21 17a17 17 0 0 1-15-15 2 2 0 0 1 .5-1.5z" />
      <path d="M3 3l18 18" />
    </Fragment>,
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
