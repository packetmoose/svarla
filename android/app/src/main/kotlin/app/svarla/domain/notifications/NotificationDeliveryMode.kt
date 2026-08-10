package app.svarla.domain.notifications

/**
 * How the app receives push notifications from the server.
 *
 * - UNIFIED_PUSH: Via a UnifiedPush distributor (e.g., ntfy). Battery-friendly, recommended.
 * - WEBSOCKET: Persistent WebSocket connection (like Signal without FCM). Requires battery
 *   optimization exemption to stay alive in background.
 * - NONE: No background delivery. Notifications only arrive while the app is open.
 */
enum class NotificationDeliveryMode {
    UNIFIED_PUSH,
    WEBSOCKET,
    NONE
}
