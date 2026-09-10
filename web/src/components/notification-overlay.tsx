import { h, Component } from "preact";
import { navigate } from "../router";
import {
  subscribeNotifications,
  dismissNotification,
  type AppNotification,
  type AppNotificationKind,
} from "../notifications";

interface NotificationOverlayState {
  notifications: AppNotification[];
}

/** A small glyph per notification kind. Plain text glyphs match the app's banners. */
function kindIcon(kind: AppNotificationKind): string {
  switch (kind) {
    case "message":
      return "\u2709"; // ✉
    case "device":
      return "\u26A0"; // ⚠
    case "call":
      return "\u260E"; // ☎
    default:
      return "\u2139"; // ℹ
  }
}

/**
 * App-wide notification overlay. Renders the shared notification center's
 * visible list (up to 3), each with an icon, title, optional body, and a
 * dismiss button. Notifications auto-dismiss on a timeout (managed by the
 * store); when one leaves, the next queued one appears. Clicking a notification
 * with an `href` navigates there and dismisses it.
 *
 * This replaces the per-type banner components (device login, incoming SMS) —
 * new notification types just push into the store and appear here.
 */
export class NotificationOverlay extends Component<
  Record<string, never>,
  NotificationOverlayState
> {
  state: NotificationOverlayState = {
    notifications: [],
  };

  private unsubscribe: (() => void) | null = null;

  componentDidMount() {
    this.unsubscribe = subscribeNotifications((notifications) => {
      this.setState({ notifications });
    });
  }

  componentWillUnmount() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleClick = (n: AppNotification) => {
    dismissNotification(n.id);
    if (n.href) navigate(n.href);
  };

  private handleDismiss = (e: Event, id: string) => {
    e.stopPropagation();
    dismissNotification(id);
  };

  render() {
    const { notifications } = this.state;
    if (notifications.length === 0) return null;

    return (
      <div
        class="notification-overlay"
        role="region"
        aria-label="Notifications"
      >
        {notifications.map((n) => {
          const clickable = !!n.href;
          const ariaLabel =
            n.title + (n.body ? `: ${n.body}` : "") +
            (clickable ? ". Activate to open." : "");
          return (
            <div
              key={n.id}
              class={`app-notification app-notification-${n.kind}`}
              role={clickable ? "button" : "status"}
              aria-live="polite"
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? ariaLabel : undefined}
              onClick={clickable ? () => this.handleClick(n) : undefined}
              onKeyDown={
                clickable
                  ? (e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        this.handleClick(n);
                      }
                    }
                  : undefined
              }
            >
              <span class="app-notification-icon" aria-hidden="true">
                {kindIcon(n.kind)}
              </span>
              <span class="app-notification-text">
                <span class="app-notification-title">{n.title}</span>
                {n.body ? (
                  <span class="app-notification-body">{n.body}</span>
                ) : null}
              </span>
              <button
                type="button"
                class="app-notification-dismiss"
                onClick={(e) => this.handleDismiss(e, n.id)}
                aria-label="Dismiss notification"
              >
                {"\u2715"}
              </button>
            </div>
          );
        })}
      </div>
    );
  }
}
