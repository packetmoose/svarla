/**
 * Bridges server websocket events into the app-wide notification center
 * ({@link ./notifications}). It normalizes the two server channels —
 * `notification_created` (incoming call/SMS, missed/blocked call) and the
 * dedicated `new_device_login` event — into a single {@link AppNotification}
 * model and pushes them, so every type flows through one overlay.
 *
 * Kept out of any single UI component so notifications fire app-wide regardless
 * of the active route.
 */
import { getWebSocket, initWebSocket } from "./ws";
import { pushNotification, type AppNotification } from "./notifications";

/** The `incoming_sms`/`incoming_call`/... payload on `notification_created`. */
interface NotificationPayload {
  callerNumber?: string;
  senderNumber?: string;
  providerNumber?: string | null;
  providerLabel?: string | null;
  contactName?: string | null;
  messagePreview?: string | null;
  deviceLabel?: string | null;
  timestamp?: string;
}

interface NotificationCreatedEvent {
  id?: string;
  notificationType?: string;
  payload?: NotificationPayload;
}

interface NewDeviceLoginEvent {
  deviceId?: string;
  deviceName?: string;
  timestamp?: string;
}

/** Best display name for a peer: contact name if resolved, else the number. */
function peerLabel(payload: NotificationPayload, number: string): string {
  return payload.contactName?.trim() ? payload.contactName : number;
}

/** Deep link to a conversation thread (matches the Call History action). */
function conversationHref(
  peerNumber: string,
  providerNumber: string | null | undefined,
): string {
  let href = `/conversations?to=${encodeURIComponent(peerNumber)}`;
  if (providerNumber) href += `&from=${encodeURIComponent(providerNumber)}`;
  return href;
}

/** Map a `notification_created` event to an {@link AppNotification}, or null. */
function fromNotificationCreated(
  event: NotificationCreatedEvent,
): AppNotification | null {
  const payload = event.payload ?? {};
  if (!event.id) return null;

  switch (event.notificationType) {
    case "incoming_sms": {
      const sender = payload.senderNumber ?? "";
      if (!sender) return null;
      return {
        id: event.id,
        kind: "message",
        title: `New message from ${peerLabel(payload, sender)}`,
        body: payload.messagePreview?.trim() ? payload.messagePreview : null,
        href: conversationHref(sender, payload.providerNumber),
      };
    }
    case "missed_call": {
      const caller = payload.callerNumber ?? "";
      if (!caller) return null;
      return {
        id: event.id,
        kind: "call",
        title: `Missed call from ${peerLabel(payload, caller)}`,
        href: "/call-history",
      };
    }
    case "blocked_call": {
      const caller = payload.callerNumber ?? "";
      if (!caller) return null;
      return {
        id: event.id,
        kind: "call",
        title: `Blocked call from ${peerLabel(payload, caller)}`,
        href: "/call-history",
      };
    }
    // `incoming_call` is handled by the dedicated calling surface
    // (IncomingCallSurface), so it is intentionally NOT turned into a toast
    // here — that would double up with the ringing UI.
    default:
      return null;
  }
}

/** Map a `new_device_login` event to an {@link AppNotification}, or null. */
function fromNewDeviceLogin(event: NewDeviceLoginEvent): AppNotification | null {
  if (!event.deviceId) return null;
  return {
    id: event.deviceId,
    kind: "device",
    title: "New device logged in",
    body: event.deviceName ?? "Unknown device",
    href: "/settings?tab=devices",
  };
}

let started = false;
let unsubscribers: Array<() => void> = [];

/**
 * Start bridging websocket events into the notification center. Idempotent.
 * Subscriptions on the shared ws client persist across reconnects, so this is
 * safe to call once after authentication.
 */
export function startNotificationSource(): void {
  if (started) return;
  started = true;

  const ws = getWebSocket() ?? initWebSocket();

  unsubscribers = [
    ws.subscribe("notification_created", (data: unknown) => {
      const n = fromNotificationCreated(data as NotificationCreatedEvent);
      if (n) pushNotification(n);
    }),
    ws.subscribe("new_device_login", (data: unknown) => {
      const n = fromNewDeviceLogin(data as NewDeviceLoginEvent);
      if (n) pushNotification(n);
    }),
  ];
}

/** Stop bridging (on logout). Idempotent. */
export function stopNotificationSource(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  started = false;
}
