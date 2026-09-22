/**
 * deviceLifecycle — the browser device as an inbound call target.
 *
 * The browser device is already provisioned at login: `login.tsx` POSTs
 * `/api/auth/login` with `deviceName: "Web Browser"` and persists the resulting
 * `session_token` + `device_id` in `localStorage`; `auth-routes.ts` applies the
 * `skipDeviceLimit` flag for the `Web Browser` device name (Requirements
 * 1.1–1.3). "Registration" in this design therefore *reuses* that persisted
 * device rather than introducing a separate registration flow.
 *
 * This module (Task 5.1) implements:
 *   - `ensureRegistered()` — reuse the persisted `localStorage` `device_id`,
 *     single-flight so concurrent callers share one in-flight promise, only
 *     provision when the id is missing (Requirements 1.1, 1.4, 1.5).
 *   - `deregisterOnUnload()` — best-effort `DELETE /api/devices/:deviceId` via
 *     `navigator.sendBeacon` (falling back to `fetch(..., { keepalive: true })`)
 *     on `pagehide`/unload; correctness defers to the server reaper
 *     (Requirements 1.11, 1.12).
 *   - `logout()` — `POST /api/auth/logout` then clear the persisted `device_id`
 *     (Requirement 1.9).
 *   - A `registered` store the UI subscribes to so the Incoming_Call_Surface is
 *     disabled while no Web_Device is registered (Requirement 1.10).
 *
 * Reconnect reconciliation, the 10s registration timeout, the "inbound calling
 * unavailable" error surface, and the manual retry control (Requirements
 * 1.6–1.8, 1.13, 1.14) are layered on by Task 5.2:
 *   - `reconcileOnReconnect()` — on `ws_connected`, check whether the persisted
 *     `device_id` is still active in the Device_Registry (via `GET /api/devices`)
 *     and reuse it; if it has been reaped/deactivated, re-provision a new
 *     Web_Device via the injected `provision` hook and update the persisted id
 *     (Requirements 1.13, 1.14).
 *   - A 10s registration timeout and error handling: a registration that
 *     exceeds 10s or returns an error is treated as failed. The session is
 *     retained, the `registered` store carries an "inbound calling unavailable"
 *     error, and a manual retry control (`retry()`) re-attempts registration
 *     (Requirements 1.6, 1.7, 1.8).
 *
 * Persistence uses the existing `localStorage` `device_id` (a deliberate
 * deviation from Requirement 1.5's "session storage" to match shipped login
 * code and avoid a redundant device per tab).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12,
 * 1.13, 1.14.
 */

import { api } from "../api";
import { createStore, type Store } from "../state";

/** The `localStorage` key under which login persists the Web_Device id. */
export const DEVICE_ID_STORAGE_KEY = "device_id";

/**
 * Maximum time a registration attempt (provisioning or reconnect re-provision)
 * may run before it is treated as failed (Requirement 1.6). Exposed so tests
 * can drive the timeout deterministically.
 */
export const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * The message key surfaced when registration fails (timeout or error). The UI
 * renders this alongside the manual retry control (Requirements 1.6, 1.7).
 */
export const INBOUND_UNAVAILABLE_MESSAGE = "inbound calling unavailable";

/**
 * Observable registration state the UI gates the Incoming_Call_Surface on
 * (Requirement 1.10) and renders the "inbound calling unavailable" error +
 * manual retry control from (Requirements 1.6, 1.7, 1.8).
 */
export interface DeviceRegistrationState {
  /** The registered Web_Device id, or `null` when no device is registered. */
  deviceId: string | null;
  /**
   * A user-facing message key when registration has failed (timeout or error),
   * or `null` when registration is healthy. When set (to
   * `INBOUND_UNAVAILABLE_MESSAGE`), the UI disables inbound calling and shows a
   * manual retry control (Requirements 1.6, 1.7).
   */
  error: string | null;
  /**
   * True while a registration/reconciliation attempt is in flight. The UI can
   * use this to disable the retry control and show progress.
   */
  registering: boolean;
}

export interface DeviceLifecycle {
  /**
   * Ensures a usable Web_Device id exists and returns it. Reuses the persisted
   * `localStorage` `device_id` from login. If absent (edge), provisions via the
   * injected `provision` hook.
   *
   * Single-flight: concurrent callers share one in-flight promise so a load
   * never yields a duplicate Web_Device (Requirements 1.1, 1.4).
   */
  ensureRegistered(): Promise<string>;

  /**
   * Registers a best-effort deregistration on `pagehide`/unload: a
   * `DELETE /api/devices/:deviceId` sent via `navigator.sendBeacon`, falling
   * back to `fetch(..., { keepalive: true })`. Delivery is not guaranteed;
   * correctness defers to the server reaper (Requirements 1.11, 1.12).
   *
   * Returns a disposer that removes the listeners.
   */
  deregisterOnUnload(): () => void;

  /**
   * On `ws_connected`: if the persisted `device_id` is still active in the
   * Device_Registry, reuse it; if reaped/deactivated, re-provision a new
   * Web_Device via the injected `provision` hook and update the persisted id
   * (Requirements 1.13, 1.14).
   *
   * Subject to the same 10s timeout + error handling as `ensureRegistered`:
   * exceeding 10s or an error retains the session and surfaces "inbound calling
   * unavailable" with a manual retry (Requirements 1.6, 1.7, 1.8).
   */
  reconcileOnReconnect(): Promise<string>;

  /**
   * Re-attempts registration after a failure (Requirement 1.8). Clears the
   * error state and re-runs `ensureRegistered`; rejects (leaving the error
   * surfaced) if the attempt fails again.
   */
  retry(): Promise<string>;

  /**
   * `POST /api/auth/logout` (invalidates the session + deregisters) then clears
   * the persisted device id and the registration state (Requirement 1.9).
   */
  logout(): Promise<void>;

  /** Observable registration state for gating the Incoming_Call_Surface (Req 1.10). */
  readonly registered: Store<DeviceRegistrationState>;
}

/**
 * Provisions a fresh Web_Device and returns its id. Provisioning is normally
 * done at login, so the persisted `device_id` is expected to already exist; this
 * hook runs on the missing-id edge (`ensureRegistered`) and after the persisted
 * device has been reaped/deactivated (`reconcileOnReconnect`, Requirement 1.14).
 * The default implementation rejects, because a new Web_Device cannot be created
 * without re-authenticating; the app shell (Task 9) injects a real hook.
 */
export type ProvisionDevice = () => Promise<string>;

/**
 * A device record as returned by `GET /api/devices`. Only the fields this
 * module needs are typed.
 */
interface DeviceListEntry {
  device_id: string;
  is_active: boolean;
}

interface DeviceListResponse {
  devices: DeviceListEntry[];
}

export interface DeviceLifecycleOptions {
  /**
   * Hook to provision a new Web_Device when no id is persisted (edge) or after
   * the persisted id has been reaped (Requirement 1.14). Defaults to a
   * rejecting stub.
   */
  provision?: ProvisionDevice;

  /**
   * Overrides the registration timeout (Requirement 1.6). Defaults to
   * {@link REGISTRATION_TIMEOUT_MS} (10s). Primarily a test seam.
   */
  registrationTimeoutMs?: number;
}

function readPersistedDeviceId(): string | null {
  try {
    const id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    return id && id.length > 0 ? id : null;
  } catch {
    // localStorage can throw in privacy modes / disabled storage.
    return null;
  }
}

function writePersistedDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  } catch {
    // Best-effort; a failure to persist does not invalidate the live id.
  }
}

function clearPersistedDeviceId(): void {
  try {
    localStorage.removeItem(DEVICE_ID_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

/**
 * Builds the `DELETE /api/devices/:deviceId` URL, embedding the current session
 * token as a query parameter so a `sendBeacon` request (which cannot set an
 * `Authorization` header) is still authenticated by the server. The regular
 * `fetch` fallback also uses this URL and additionally carries the header.
 */
function deregisterUrl(deviceId: string): string {
  const path = `/api/devices/${encodeURIComponent(deviceId)}`;
  let token: string | null = null;
  try {
    token = localStorage.getItem("session_token");
  } catch {
    token = null;
  }
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

/**
 * Races `work` against a `timeoutMs` deadline. If the deadline wins, the
 * returned promise rejects with a timeout error (Requirement 1.6); the pending
 * `work` is left to settle on its own (it can no longer affect the caller).
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Web_Device registration exceeded ${timeoutMs}ms`),
      );
    }, timeoutMs);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const defaultProvision: ProvisionDevice = () =>
  Promise.reject(
    new Error(
      "No persisted device_id and no provisioning hook configured; a Web_Device is provisioned at login.",
    ),
  );

class DeviceLifecycleImpl implements DeviceLifecycle {
  readonly registered: Store<DeviceRegistrationState>;

  private readonly provision: ProvisionDevice;

  private readonly registrationTimeoutMs: number;

  /**
   * The single in-flight `ensureRegistered` promise, or `null` when idle.
   * Sharing one promise across concurrent callers is the single-flight
   * guarantee that prevents a duplicate Web_Device on a busy load.
   */
  private inFlight: Promise<string> | null = null;

  constructor(options: DeviceLifecycleOptions = {}) {
    this.provision = options.provision ?? defaultProvision;
    this.registrationTimeoutMs =
      options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS;
    this.registered = createStore<DeviceRegistrationState>({
      deviceId: readPersistedDeviceId(),
      error: null,
      registering: false,
    });
  }

  ensureRegistered(): Promise<string> {
    // Fast path: an id is already persisted — reuse it (Requirements 1.4, 1.5).
    const persisted = readPersistedDeviceId();
    if (persisted) {
      // A healthy reuse clears any prior failure state.
      const current = this.registered.getState();
      if (current.deviceId !== persisted || current.error !== null) {
        this.registered.setState({ deviceId: persisted, error: null });
      }
      return Promise.resolve(persisted);
    }

    // No persisted id — provision one (edge; provisioning normally happens at
    // login). This carries the 10s timeout + error/retry surface.
    return this.provisionAndPersist();
  }

  reconcileOnReconnect(): Promise<string> {
    // Single-flight with `ensureRegistered`: if a registration attempt is
    // already running, reuse it rather than starting a second (Requirement 1.4).
    if (this.inFlight) {
      return this.inFlight;
    }

    const persisted = readPersistedDeviceId();
    if (!persisted) {
      // Nothing persisted (e.g. reaped-then-cleared) — provision fresh.
      return this.provisionAndPersist();
    }

    // Check whether the persisted device is still active in the registry. If it
    // is, reuse it (Requirement 1.13); if it was reaped/deactivated, re-provision
    // and update the persisted id (Requirement 1.14).
    this.beginRegistering();
    this.inFlight = withTimeout(
      this.reconcile(persisted),
      this.registrationTimeoutMs,
    )
      .then((deviceId) => {
        this.finishRegistering(deviceId);
        return deviceId;
      })
      .catch((err) => {
        this.failRegistering();
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  retry(): Promise<string> {
    // Clear the failure surface and re-attempt registration (Requirement 1.8).
    // `reconcileOnReconnect` covers both the reuse-if-active and re-provision
    // paths and is safe when nothing is persisted.
    if (this.registered.getState().error !== null) {
      this.registered.setState({ error: null });
    }
    return this.reconcileOnReconnect();
  }

  /**
   * Resolves the persisted device against the registry: reuse when still
   * active, otherwise re-provision and persist the new id (Requirements 1.13,
   * 1.14).
   */
  private async reconcile(persisted: string): Promise<string> {
    const active = await this.isDeviceActive(persisted);
    if (active) {
      return persisted;
    }
    // Reaped/deactivated — provision a new Web_Device and update the persisted
    // id (Requirement 1.14).
    const deviceId = await this.provision();
    writePersistedDeviceId(deviceId);
    return deviceId;
  }

  /**
   * Provisions a new Web_Device (single-flight) with the registration timeout
   * and error/retry surface applied (Requirements 1.1, 1.6, 1.7).
   */
  private provisionAndPersist(): Promise<string> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.beginRegistering();
    this.inFlight = withTimeout(this.provision(), this.registrationTimeoutMs)
      .then((deviceId) => {
        writePersistedDeviceId(deviceId);
        this.finishRegistering(deviceId);
        return deviceId;
      })
      .catch((err) => {
        this.failRegistering();
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /**
   * Reports whether `deviceId` is still an active device in the registry, read
   * from `GET /api/devices` (Requirement 1.13). A failed request is treated as
   * "unknown" and re-raised so the caller surfaces the registration error
   * rather than silently re-provisioning a duplicate.
   */
  private async isDeviceActive(deviceId: string): Promise<boolean> {
    const result = await api.get<DeviceListResponse>("/api/devices");
    if (!result.ok) {
      throw new Error(
        `Failed to list devices during reconcile (status ${result.status})`,
      );
    }
    return result.data.devices.some(
      (d) => d.device_id === deviceId && d.is_active,
    );
  }

  private beginRegistering(): void {
    this.registered.setState({ registering: true, error: null });
  }

  private finishRegistering(deviceId: string): void {
    this.registered.setState({ deviceId, registering: false, error: null });
  }

  /**
   * Marks registration failed: retain the session (do not clear the persisted
   * id) and surface "inbound calling unavailable" so the UI shows the manual
   * retry control (Requirements 1.6, 1.7).
   */
  private failRegistering(): void {
    this.registered.setState({
      registering: false,
      error: INBOUND_UNAVAILABLE_MESSAGE,
    });
  }

  deregisterOnUnload(): () => void {
    const handler = () => {
      const deviceId = readPersistedDeviceId();
      if (!deviceId) return;
      this.beaconDeregister(deviceId);
    };

    // `pagehide` is the reliable modern signal; `beforeunload` covers browsers
    // that skip `pagehide`. Both are best-effort (Requirements 1.11, 1.12).
    window.addEventListener("pagehide", handler);
    window.addEventListener("beforeunload", handler);

    return () => {
      window.removeEventListener("pagehide", handler);
      window.removeEventListener("beforeunload", handler);
    };
  }

  async logout(): Promise<void> {
    // Best-effort server-side logout; regardless of the result the persisted id
    // and local registration state are cleared (Requirement 1.9).
    try {
      await api.post("/api/auth/logout");
    } finally {
      clearPersistedDeviceId();
      this.registered.setState({
        deviceId: null,
        error: null,
        registering: false,
      });
    }
  }

  /**
   * Fire-and-forget deregistration for the unload path. Prefers
   * `navigator.sendBeacon` (which survives the unload) and falls back to a
   * `keepalive` `fetch` when `sendBeacon` is unavailable or refuses the request.
   */
  private beaconDeregister(deviceId: string): void {
    const url = deregisterUrl(deviceId);

    // `sendBeacon` issues a POST; the DELETE route accepts the deviceId in the
    // path, so the method is immaterial to the server for this best-effort call.
    // Prefer it because it is guaranteed to be scheduled during unload.
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon(url)
      ) {
        return;
      }
    } catch {
      // Fall through to the fetch fallback.
    }

    // Fallback: a keepalive DELETE that the browser allows to outlive the page.
    try {
      let token: string | null = null;
      try {
        token = localStorage.getItem("session_token");
      } catch {
        token = null;
      }
      void fetch(url, {
        method: "DELETE",
        keepalive: true,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }).catch(() => {
        // Best-effort; correctness defers to the server reaper (Req 1.12).
      });
    } catch {
      // Best-effort; correctness defers to the server reaper (Req 1.12).
    }
  }
}

/**
 * Create a `DeviceLifecycle`. One instance per tab is expected (the app shell
 * owns it and subscribes the calling UI to `registered`).
 */
export function createDeviceLifecycle(
  options: DeviceLifecycleOptions = {},
): DeviceLifecycle {
  return new DeviceLifecycleImpl(options);
}
