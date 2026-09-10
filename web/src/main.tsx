import { h, render, Component, Fragment } from "preact";
import { Router, registerRoutes, navigate } from "./router";
import { Nav } from "./components/nav";
import { NotificationOverlay } from "./components/notification-overlay";
import {
  startNotificationSource,
  stopNotificationSource,
} from "./notification-source";
import { AndroidBanner } from "./components/android-banner";
import { Login } from "./components/login";
import { CallHistory } from "./components/call-history";
import { Conversations } from "./components/conversations";
import { Settings } from "./components/settings";
import { Dashboard } from "./components/dashboard";
import { Download } from "./components/download";
import { initWebSocket, getWebSocket } from "./ws";
import { initTheme } from "./theme";
import { initScrollActivity } from "./scroll-activity";

// Calling stack (Task 9.1 wiring).
import { detectCapabilities } from "./call/capability-guard";
import {
  createCallController,
  type CallController,
} from "./call/call-controller";
import {
  createDeviceLifecycle,
  type DeviceLifecycle,
} from "./call/device-lifecycle";
import { createAlerting } from "./call/alerting";
import { setDialerOpener } from "./call/dialer-bridge";
import { Dialer } from "./components/dialer";
import { IncomingCallSurface } from "./components/incoming-call-surface";
import { CallBanner } from "./components/call-banner";

// Register application routes (no login route — App handles that)
registerRoutes([
  { path: "/", component: Dashboard },
  { path: "/call-history", component: CallHistory },
  { path: "/conversations", component: Conversations },
  { path: "/settings", component: Settings },
  { path: "/download", component: Download },
]);

function isAuthenticated(): boolean {
  return !!localStorage.getItem("session_token");
}

/**
 * The calling stack, instantiated once per tab. Only created when the browser
 * can actually support calling (Secure_Context + WebRTC APIs, Requirements
 * 15.2, 15.3) so the surfaces never attempt `getUserMedia` in an unsupported
 * environment. When calling is unsupported this stays `null` and the App shell
 * renders no calling UI.
 */
interface CallingStack {
  controller: CallController;
  deviceLifecycle: DeviceLifecycle;
  /** Hidden `<audio>` element the remote track plays through (Requirement 4.8). */
  remoteAudio: HTMLAudioElement;
}

let callingStack: CallingStack | null = null;

/**
 * The `ws_connected` / `pagehide` disposers for the current calling session, so
 * they can be torn down on logout without leaking listeners.
 */
let callingWsUnsub: (() => void) | null = null;
let callingUnloadDispose: (() => void) | null = null;

/**
 * Create the single per-tab remote-audio element the WebRTC remote track plays
 * through (Requirement 4.8). Hidden, autoplay, and kept in the DOM so playback
 * survives surface re-renders. Reused across calls; the `WebRtcCallClient`
 * attaches/detaches the remote track on it.
 */
function createRemoteAudioElement(): HTMLAudioElement {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.hidden = true;
  audio.setAttribute("aria-hidden", "true");
  audio.style.display = "none";
  document.body.appendChild(audio);
  return audio;
}

/**
 * Lazily build the calling stack, gated on the capability guard. Returns `null`
 * when calling is unsupported so the UI simply omits the calling surfaces
 * (Requirements 15.2, 15.3). Safe to call repeatedly — the stack is built once.
 */
function ensureCallingStack(): CallingStack | null {
  if (callingStack) return callingStack;

  if (!detectCapabilities().callingSupported) {
    return null;
  }

  const ws = getWebSocket() ?? initWebSocket();
  const remoteAudio = createRemoteAudioElement();
  const alerting = createAlerting({ remoteAudio });
  const controller = createCallController({ ws, remoteAudio, alerting });
  const deviceLifecycle = createDeviceLifecycle();

  callingStack = { controller, deviceLifecycle, remoteAudio };
  return callingStack;
}

/**
 * Start the calling stack: subscribe the controller to ws events, register the
 * browser device as an inbound call target, and reconcile/re-register on every
 * (re)connect (Requirements 1.9, 1.10, 1.11, 1.13, 1.14, 14.3).
 *
 *   - `controller.start()` wires the `call_event`/`call_cancelled`/`ws_connected`
 *     subscriptions the state machine drives from.
 *   - On `ws_connected`, reconcile the browser device against the registry
 *     (`reconcileOnReconnect()` reuses the persisted id when still active and
 *     re-provisions when it was reaped, Requirements 1.13, 1.14). The initial
 *     connect also reconciles, which covers `ensureRegistered()`'s reuse path.
 *   - `deregisterOnUnload()` best-effort deregisters the device on `pagehide`
 *     (Requirement 1.11).
 *
 * Idempotent: a second call while already started is a no-op.
 */
function startCallingStack(stack: CallingStack): void {
  if (callingWsUnsub || callingUnloadDispose) return;

  stack.controller.start();

  // Register the browser device now (reuse the login-provisioned id) so it is
  // an inbound target immediately, and again on every (re)connect.
  void stack.deviceLifecycle.ensureRegistered().catch(() => {
    // Failure surfaces via the deviceLifecycle `registered` store; the app
    // shell keeps running.
  });

  const ws = getWebSocket() ?? initWebSocket();
  callingWsUnsub = ws.subscribe("ws_connected", () => {
    void stack.deviceLifecycle.reconcileOnReconnect().catch(() => {
      /* surfaced via the registered store */
    });
  });

  callingUnloadDispose = stack.deviceLifecycle.deregisterOnUnload();
}

/**
 * Tear down the calling stack on logout/session expiry: stop the controller
 * (which releases any active session and mic), remove the ws/unload listeners,
 * and clear the persisted device via `deviceLifecycle.logout()` (Requirement
 * 1.9). Best-effort and idempotent.
 */
function teardownCallingStack(): void {
  if (!callingStack) return;

  callingWsUnsub?.();
  callingWsUnsub = null;
  callingUnloadDispose?.();
  callingUnloadDispose = null;

  callingStack.controller.stop();
  void callingStack.deviceLifecycle.logout().catch(() => {
    /* best-effort; the session is being torn down regardless */
  });
}

interface AppState {
  authenticated: boolean;
  /**
   * Whether the per-tab calling stack has been built (browser supports calling
   * AND the user is authenticated). Held in component state so that building
   * the stack forces a re-render — the render reads the module-level
   * `callingStack`, and without a state flag a stack built in
   * `componentDidMount` would never repaint the "Dial" affordance/surfaces.
   */
  callingReady: boolean;
  /** Whether the nav-launched Dialer overlay is open (Task 9.1 plumbing). */
  dialerOpen: boolean;
  /** Optional destination to pre-fill the Dialer with (e.g. "call back"). */
  dialerDestination?: string;
}

class App extends Component<Record<string, never>, AppState> {
  state: AppState = {
    authenticated: isAuthenticated(),
    callingReady: false,
    dialerOpen: false,
    dialerDestination: undefined,
  };

  componentDidMount() {
    // Listen for session cleared by api.ts (sets this flag before hash change)
    window.addEventListener("session-expired", this.handleSessionExpired);

    // If already authenticated at boot, bring the calling stack online. Flip
    // `callingReady` so the first paint (which ran before this hook) repaints
    // with the "Dial" affordance and the call surfaces mounted.
    if (this.state.authenticated) {
      this.bringCallingOnline();
      // Notifications are independent of the calling stack (they work even
      // where calling is unsupported), so start the source directly.
      startNotificationSource();
    }
  }

  /**
   * Build and start the calling stack (idempotent) and re-render so the calling
   * UI appears. On a browser that supports calling this sets `callingReady`;
   * when calling is unsupported the stack is `null` and the render shows the
   * disabled "Dial" affordance with an explanatory reason instead.
   */
  private bringCallingOnline(): void {
    const stack = ensureCallingStack();
    if (stack) {
      startCallingStack(stack);
      // Route-rendered components (e.g. call-history "call back") open the
      // Dialer through this bridge since they can't receive props.
      setDialerOpener(this.openDialer);
    }
    // Re-render regardless: `callingReady` true mounts the surfaces; false
    // leaves the disabled "Dial" affordance visible (Requirements 15.2, 15.3).
    this.setState({ callingReady: stack !== null });
  }

  componentWillUnmount() {
    window.removeEventListener("session-expired", this.handleSessionExpired);
  }

  private handleSessionExpired = () => {
    // Route the existing logout/session-expiry path through the device
    // lifecycle so the browser device is deregistered and any active call is
    // torn down (Requirement 1.9).
    teardownCallingStack();
    stopNotificationSource();
    setDialerOpener(null);
    this.setState({ authenticated: false, callingReady: false, dialerOpen: false });
  };

  private handleLogin = () => {
    this.setState({ authenticated: true });
    initWebSocket();
    // Bring the calling stack online now that the session exists.
    this.bringCallingOnline();
    startNotificationSource();
    // Ensure we navigate to dashboard after login
    navigate("/");
  };

  /** Open the Dialer overlay, optionally pre-filled (e.g. from "call back"). */
  private openDialer = (destination?: string) => {
    this.setState({ dialerOpen: true, dialerDestination: destination });
  };

  private closeDialer = () => {
    this.setState({ dialerOpen: false, dialerDestination: undefined });
  };

  render() {
    const { authenticated, callingReady, dialerOpen, dialerDestination } =
      this.state;

    if (!authenticated) {
      return (
        <div class="layout">
          <main class="main-content">
            <Login onLogin={this.handleLogin} />
          </main>
        </div>
      );
    }

    // The calling surfaces are rendered only when the browser supports calling
    // (Requirements 15.2, 15.3). Each is a distinct, state-driven overlay — the
    // Dialer popover, the IncomingCallSurface modal, and the InCallSurface
    // overlay never share a container; at most one InCallSurface exists per tab.
    const stack = callingReady ? callingStack : null;

    return (
      <div class="layout">
        <Nav />
        <main class="main-content">
          <Router />
        </main>
        <NotificationOverlay />
        <AndroidBanner />
        {stack ? (
          <Fragment>
            <Dialer
              controller={stack.controller}
              open={dialerOpen}
              onClose={this.closeDialer}
              prefilledDestination={dialerDestination}
            />
            <IncomingCallSurface controller={stack.controller} />
            <CallBanner
              controller={stack.controller}
              remoteAudio={stack.remoteAudio}
            />
          </Fragment>
        ) : null}
      </div>
    );
  }
}

// Initialize theme (applies stored preference, syncs with OS changes)
initTheme();

// Reveal custom scrollbars only while actively scrolling / hovering.
initScrollActivity();

// Initialize WebSocket connection if already authenticated
if (isAuthenticated()) {
  initWebSocket();
}

render(<App />, document.getElementById("app")!);
