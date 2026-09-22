/**
 * Dialer bridge — a tiny module-level indirection that lets router-rendered
 * components (which do not receive App props) open the nav-launched Dialer.
 *
 * The App shell (`main.tsx`) owns the Dialer open-state and registers its
 * `openDialer` opener here via `setDialerOpener` whenever the calling stack
 * exists (i.e. the browser supports calling). Components that cannot receive
 * the opener through props — notably the router-rendered `call-history.tsx`
 * "call back" affordance (Requirement 17.2) — import `openDialer` and route
 * through the exact same open path as the nav "dial" affordance.
 *
 * When calling is unsupported no opener is registered, so `openDialer` is a
 * no-op and `isDialerAvailable()` reports false — callers can hide their
 * "call back" affordance accordingly.
 */

export type DialerOpener = (destination?: string) => void;

let opener: DialerOpener | null = null;

/**
 * Register (or clear) the Dialer opener. `main.tsx` calls this with its
 * `App.openDialer` when the calling stack comes online and with `null` on
 * teardown so no stale closure is retained.
 */
export function setDialerOpener(next: DialerOpener | null): void {
  opener = next;
}

/**
 * Whether a Dialer opener is currently registered (i.e. calling is supported
 * and the App shell is mounted). Consumers use this to gate optional "call
 * back" affordances.
 */
export function isDialerAvailable(): boolean {
  return opener !== null;
}

/**
 * Open the Dialer, optionally pre-filled with a destination (e.g. the number
 * to call back). No-op when no opener is registered.
 */
export function openDialer(destination?: string): void {
  opener?.(destination);
}
