import { h, render, Component } from "preact";
import { Router, registerRoutes, navigate } from "./router";
import { Nav } from "./components/nav";
import { CallBanner } from "./components/call-banner";
import { NewDeviceBanner } from "./components/new-device-banner";
import { Login } from "./components/login";
import { CallHistory } from "./components/call-history";
import { Conversations } from "./components/conversations";
import { Settings } from "./components/settings";
import { Dashboard } from "./components/dashboard";
import { initWebSocket } from "./ws";

// Register application routes (no login route — App handles that)
registerRoutes([
  { path: "/", component: Dashboard },
  { path: "/call-history", component: CallHistory },
  { path: "/conversations", component: Conversations },
  { path: "/settings", component: Settings },
]);

function isAuthenticated(): boolean {
  return !!localStorage.getItem("session_token");
}

interface AppState {
  authenticated: boolean;
}

class App extends Component<Record<string, never>, AppState> {
  state: AppState = {
    authenticated: isAuthenticated(),
  };

  componentDidMount() {
    // Listen for session cleared by api.ts (sets this flag before hash change)
    window.addEventListener("session-expired", this.handleSessionExpired);
  }

  componentWillUnmount() {
    window.removeEventListener("session-expired", this.handleSessionExpired);
  }

  private handleSessionExpired = () => {
    this.setState({ authenticated: false });
  };

  private handleLogin = () => {
    this.setState({ authenticated: true });
    initWebSocket();
    // Ensure we navigate to dashboard after login
    navigate("/");
  };

  render() {
    const { authenticated } = this.state;

    if (!authenticated) {
      return (
        <div class="layout">
          <main class="main-content">
            <Login onLogin={this.handleLogin} />
          </main>
        </div>
      );
    }

    return (
      <div class="layout">
        <Nav />
        <main class="main-content">
          <Router />
        </main>
        <CallBanner />
        <NewDeviceBanner />
      </div>
    );
  }
}

// Initialize WebSocket connection if already authenticated
if (isAuthenticated()) {
  initWebSocket();
}

render(<App />, document.getElementById("app")!);
