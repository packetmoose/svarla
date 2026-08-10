import { h, Component } from "preact";
import { getWebSocket } from "../ws";
import { navigate } from "../router";

interface NewDeviceAlert {
  id: string;
  deviceName: string;
  timestamp: string;
}

interface NewDeviceBannerState {
  alerts: NewDeviceAlert[];
}

/**
 * Persistent notification banner that shows when a new device logs in.
 * Does NOT auto-dismiss — user must click to navigate to settings/devices
 * or explicitly dismiss each notification.
 */
export class NewDeviceBanner extends Component<
  Record<string, never>,
  NewDeviceBannerState
> {
  state: NewDeviceBannerState = {
    alerts: [],
  };

  private unsubscribe: (() => void) | null = null;

  componentDidMount() {
    this.subscribeToEvents();
    // Re-subscribe when WS reconnects
    window.addEventListener("ws-reconnected", this.subscribeToEvents);
  }

  componentWillUnmount() {
    this.unsubscribe?.();
    window.removeEventListener("ws-reconnected", this.subscribeToEvents);
  }

  private subscribeToEvents = () => {
    this.unsubscribe?.();
    const ws = getWebSocket();
    if (ws) {
      this.unsubscribe = ws.subscribe(
        "new_device_login",
        this.handleNewDeviceLogin
      );
    }
  };

  private handleNewDeviceLogin = (data: unknown) => {
    const event = data as {
      deviceId?: string;
      deviceName?: string;
      timestamp?: string;
    };
    if (!event.deviceId) return;

    const alert: NewDeviceAlert = {
      id: event.deviceId,
      deviceName: event.deviceName ?? "Unknown device",
      timestamp: event.timestamp ?? new Date().toISOString(),
    };

    this.setState((prev) => ({
      alerts: [...prev.alerts, alert],
    }));
  };

  private handleClick = (alertId: string) => {
    this.setState((prev) => ({
      alerts: prev.alerts.filter((a) => a.id !== alertId),
    }));
    navigate("/settings?tab=devices");
  };

  private handleDismiss = (e: Event, alertId: string) => {
    e.stopPropagation();
    this.setState((prev) => ({
      alerts: prev.alerts.filter((a) => a.id !== alertId),
    }));
  };

  render() {
    const { alerts } = this.state;
    if (alerts.length === 0) return null;

    return (
      <div class="new-device-banner-container" role="alert" aria-live="assertive">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            class="new-device-banner"
            onClick={() => this.handleClick(alert.id)}
            role="button"
            tabIndex={0}
            aria-label={`New device logged in: ${alert.deviceName}. Click to view devices.`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.handleClick(alert.id);
              }
            }}
          >
            <span class="new-device-banner-icon">⚠</span>
            <span class="new-device-banner-text">
              New device logged in: <strong>{alert.deviceName}</strong>
            </span>
            <button
              class="new-device-banner-dismiss"
              onClick={(e) => this.handleDismiss(e, alert.id)}
              aria-label={`Dismiss notification for ${alert.deviceName}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    );
  }
}
