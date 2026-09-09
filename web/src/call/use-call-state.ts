/**
 * `useCallState` — subscribe a Preact component to a {@link CallController}'s
 * observable store (Task 9.1).
 *
 * The App shell (`main.tsx`) instantiates a single `CallController` per tab and
 * renders the call surfaces from its state. This hook is the shared binding
 * between the controller store (`web/src/state.ts` `createStore`) and Preact:
 * it reads the current state, re-renders on every store change, re-syncs once
 * on (re)subscribe (in case the state moved between the initial render and the
 * effect running), and unsubscribes on unmount.
 *
 * The individual surfaces (Dialer, IncomingCallSurface, InCallSurface) already
 * inline an equivalent subscription; this exported hook gives the App shell and
 * any future consumers one canonical implementation.
 *
 * Requirements: 4.8, 14.3 (surfaces render from the single source of truth).
 */

import { useEffect, useState } from "preact/hooks";
import type { CallController, CallControllerState } from "./call-controller";

/**
 * Subscribe to `controller.store` and return its current
 * {@link CallControllerState}, re-rendering the caller on every change.
 */
export function useCallState(controller: CallController): CallControllerState {
  const [state, setState] = useState<CallControllerState>(() =>
    controller.store.getState(),
  );

  useEffect(() => {
    // Re-sync in case the state changed between the initial read and subscribe.
    setState(controller.store.getState());
    return controller.store.subscribe(setState);
  }, [controller]);

  return state;
}
