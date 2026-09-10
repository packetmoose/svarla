/**
 * App-wide transient notification center.
 *
 * A single pushable buffer that any part of the app can post to (device logins,
 * incoming SMS, and future types). The overlay renders at most
 * {@link MAX_VISIBLE} notifications at once; each auto-dismisses after
 * {@link DEFAULT_TIMEOUT_MS}, and when a visible one leaves, the next buffered
 * one takes its place. This replaces the per-type banner components with one
 * shared surface.
 *
 * Consumers:
 *   - `pushNotification(n)` — post a notification (deduped by id).
 *   - `subscribeNotifications(fn)` — observe the visible list (for the overlay).
 *   - `dismissNotification(id)` — remove one (user dismiss / click-through).
 */

/** Max notifications shown on screen simultaneously. */
export const MAX_VISIBLE = 3;

/** Default auto-dismiss timeout for a visible notification. */
export const DEFAULT_TIMEOUT_MS = 6000;

/** A visual/semantic category, used to pick an icon and styling. */
export type AppNotificationKind = "message" | "device" | "call" | "info";

export interface AppNotification {
  /** Stable unique id (server notification id, device id, etc.). Dedupe key. */
  id: string;
  kind: AppNotificationKind;
  title: string;
  /** Optional secondary line (e.g. a message preview). */
  body?: string | null;
  /**
   * Optional navigation target (hash route, e.g.
   * `/conversations?to=...`). When set, clicking the notification navigates
   * there and dismisses it.
   */
  href?: string | null;
  /** Auto-dismiss timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

type Listener = (visible: AppNotification[]) => void;

const listeners = new Set<Listener>();

/** Notifications currently shown on screen (max {@link MAX_VISIBLE}). */
let visible: AppNotification[] = [];
/** Notifications waiting for a free slot. */
let queue: AppNotification[] = [];
/** Per-visible-notification auto-dismiss timers, keyed by notification id. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Ids that have been seen, to dedupe repeated pushes of the same event. */
const seen = new Set<string>();

function notify(): void {
  const snapshot = visible.slice();
  for (const listener of listeners) listener(snapshot);
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function armTimer(n: AppNotification): void {
  const ms = n.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  clearTimer(n.id);
  timers.set(
    n.id,
    setTimeout(() => dismissNotification(n.id), ms),
  );
}

/** Promote queued notifications into any free visible slots. */
function fillSlots(): void {
  while (visible.length < MAX_VISIBLE && queue.length > 0) {
    const next = queue.shift() as AppNotification;
    visible.push(next);
    armTimer(next);
  }
}

/**
 * Post a notification. Deduped by id (a repeated id is ignored) so the same
 * server event delivered twice — e.g. via the WS event AND a wake-signal fetch
 * — surfaces once. If all visible slots are full it waits in the buffer and is
 * shown when a slot frees up.
 */
export function pushNotification(n: AppNotification): void {
  if (seen.has(n.id)) return;
  seen.add(n.id);

  if (visible.length < MAX_VISIBLE) {
    visible.push(n);
    armTimer(n);
  } else {
    queue.push(n);
  }
  notify();
}

/** Remove a notification (whether visible or still queued) and fill the slot. */
export function dismissNotification(id: string): void {
  clearTimer(id);

  const wasVisible = visible.some((n) => n.id === id);
  visible = visible.filter((n) => n.id !== id);
  queue = queue.filter((n) => n.id !== id);

  // A freed visible slot pulls in the next queued notification.
  if (wasVisible) fillSlots();

  notify();
}

/**
 * Subscribe to the visible-notification list. The listener is called
 * immediately with the current snapshot, then on every change. Returns an
 * unsubscribe function.
 */
export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener);
  listener(visible.slice());
  return () => {
    listeners.delete(listener);
  };
}

/** Test/teardown helper: clear all state. Not used in normal operation. */
export function resetNotifications(): void {
  for (const id of timers.keys()) clearTimer(id);
  visible = [];
  queue = [];
  seen.clear();
  notify();
}
