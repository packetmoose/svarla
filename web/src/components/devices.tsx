import { h, Component } from "preact";
import { api } from "../api";

interface Device {
  device_id: string;
  device_name: string;
  registered_at: string;
  last_seen_at: string;
  is_active: boolean;
}

interface DevicesListResponse {
  devices: Device[];
}

interface DevicesState {
  devices: Device[];
  loading: boolean;
  error: string;
  confirmingRemoval: string | null;
  removingId: string | null;
}

export class Devices extends Component<Record<string, never>, DevicesState> {
  state: DevicesState = {
    devices: [],
    loading: true,
    error: "",
    confirmingRemoval: null,
    removingId: null,
  };

  componentDidMount() {
    this.fetchDevices();
  }

  private getCurrentDeviceId(): string | null {
    return localStorage.getItem("device_id");
  }

  private async fetchDevices() {
    this.setState({ loading: true, error: "" });

    const result = await api.get<DevicesListResponse>("/api/devices");

    if (!result.ok) {
      this.setState({
        loading: false,
        error: "Failed to load devices",
      });
      return;
    }

    const sorted = result.data.devices
      .filter((d) => d.is_active)
      .sort(
        (a, b) =>
          new Date(b.registered_at).getTime() -
          new Date(a.registered_at).getTime()
      );

    this.setState({ devices: sorted, loading: false });
  }

  private handleRemoveClick = (deviceId: string) => {
    this.setState({ confirmingRemoval: deviceId });
  };

  private handleCancelRemoval = () => {
    this.setState({ confirmingRemoval: null });
  };

  private handleConfirmRemoval = async () => {
    const { confirmingRemoval } = this.state;
    if (!confirmingRemoval) return;

    this.setState({ removingId: confirmingRemoval, confirmingRemoval: null });

    const result = await api.delete(`/api/devices/${confirmingRemoval}`);

    if (result.ok) {
      this.setState((prev) => ({
        devices: prev.devices.filter((d) => d.device_id !== confirmingRemoval),
        removingId: null,
        error: "",
      }));
    } else {
      this.setState({
        removingId: null,
        error: "Failed to remove device. Please try again.",
      });
    }
  };

  private formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  render() {
    const { devices, loading, error, confirmingRemoval, removingId } =
      this.state;
    const currentDeviceId = this.getCurrentDeviceId();

    if (loading) {
      return (
        <div class="devices-container" role="main">
          <h1>Devices</h1>
          <p class="loading-text" aria-live="polite">
            Loading devices...
          </p>
        </div>
      );
    }

    return (
      <div class="devices-container" role="main">
        <h1>Devices</h1>

        {error && (
          <div class="devices-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {devices.length === 0 && !error && (
          <p class="devices-empty">No active devices registered.</p>
        )}

        <ul class="devices-list" aria-label="Registered devices">
          {devices.map((device) => {
            const isCurrentDevice = device.device_id === currentDeviceId;
            const isRemoving = device.device_id === removingId;
            const isConfirming = device.device_id === confirmingRemoval;

            return (
              <li key={device.device_id} class="device-card">
                <div class="device-info">
                  <span class="device-name">
                    {device.device_name}
                    {isCurrentDevice && (
                      <span class="device-current-badge"> (This device)</span>
                    )}
                  </span>
                  <span class="device-date">
                    Registered: {this.formatDate(device.registered_at)}
                  </span>
                  <span class="device-date">
                    Last seen: {this.formatDate(device.last_seen_at)}
                  </span>
                </div>

                <div class="device-actions">
                  {isConfirming ? (
                    <div
                      class="device-confirm"
                      role="alertdialog"
                      aria-label="Confirm device removal"
                    >
                      <span class="confirm-text">Remove this device?</span>
                      <button
                        class="btn-confirm-remove"
                        onClick={this.handleConfirmRemoval}
                        aria-label={`Confirm removal of ${device.device_name}`}
                      >
                        Confirm
                      </button>
                      <button
                        class="btn-cancel-remove"
                        onClick={this.handleCancelRemoval}
                        aria-label="Cancel removal"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      class="btn-remove-device"
                      onClick={() => this.handleRemoveClick(device.device_id)}
                      disabled={isCurrentDevice || isRemoving}
                      aria-label={
                        isCurrentDevice
                          ? `Cannot remove ${device.device_name} (current session)`
                          : `Remove ${device.device_name}`
                      }
                      title={
                        isCurrentDevice
                          ? "Cannot remove your current device"
                          : "Remove device"
                      }
                    >
                      {isRemoving ? "Removing..." : "Remove"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
}
