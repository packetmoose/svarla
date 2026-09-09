import { h } from "preact";
import type { VNode } from "preact";
import { useState, useEffect } from "preact/hooks";
import { navigate } from "../router";
import { homeIcon, chatIcon, callIcon, settingsIcon, phoneIcon } from "./icons";
import {
  getResolvedTheme,
  toggleTheme,
  subscribeTheme,
  type ResolvedTheme,
} from "../theme";

interface NavItem {
  label: string;
  path: string;
  icon: VNode;
}

const navItems: NavItem[] = [
  { label: "Dashboard", path: "/", icon: homeIcon() },
  { label: "Conversations", path: "/conversations", icon: chatIcon() },
  { label: "Call History", path: "/call-history", icon: callIcon() },
  { label: "Settings", path: "/settings", icon: settingsIcon() },
];

function getCurrentPath(): string {
  const hash = window.location.hash;
  if (!hash) return "/";
  const path = hash.slice(1);
  // Strip any query string (e.g. /conversations?to=...) so the path still
  // matches a nav item and stays highlighted.
  const queryIndex = path.indexOf("?");
  return queryIndex !== -1 ? path.slice(0, queryIndex) : path;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<ResolvedTheme>(getResolvedTheme());

  useEffect(() => subscribeTheme((resolved) => setTheme(resolved)), []);

  const isDark = theme === "dark";
  // Show the action the button performs: a sun to switch to light, a moon to switch to dark.
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      class="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <span class="theme-toggle-icon" aria-hidden="true">
        {isDark ? "☀" : "☾"}
      </span>
    </button>
  );
}

export interface NavProps {
  /**
   * Opens the nav-launched Dialer overlay, optionally pre-filled with a
   * destination. Provided by the App shell (`main.tsx`) only when the browser
   * supports calling. The "dial" nav affordance that calls this is added by
   * Task 9.2; the prop is threaded through here so the App-level open-state
   * plumbing (Task 9.1) type-checks.
   */
  openDialer?: (destination?: string) => void;
  /**
   * When calling is NOT available in this browsing context (e.g. a non-secure
   * HTTP origin, or a browser missing the WebRTC APIs), the App shell passes a
   * human-readable reason here. The "Dial" affordance is then rendered in a
   * DISABLED state with this reason as its tooltip/announcement, so the user
   * always sees the entry point and understands why it is unavailable
   * (Requirements 15.2, 15.3) rather than finding nothing at all.
   */
  callingDisabledReason?: string;
}

export function Nav(props: NavProps = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activePath, setActivePath] = useState(getCurrentPath());

  useEffect(() => {
    const handleHashChange = () => {
      setActivePath(getCurrentPath());
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  function handleNavClick(path: string) {
    navigate(path);
    setActivePath(path);
    setIsOpen(false);
  }

  function handleDialClick() {
    if (!props.openDialer) return;
    // "Dial" is an action, not a route: it opens the nav-launched Dialer
    // overlay (Requirement 17.2). Provided by the App shell only when the
    // browser supports calling, so the affordance is omitted otherwise.
    props.openDialer?.();
    setIsOpen(false);
  }

  function toggleMenu() {
    setIsOpen(!isOpen);
  }

  return (
    <nav class="nav" aria-label="Main navigation">
      <div class="nav-header">
        <div class="nav-header-actions">
          <button
            class="nav-toggle"
            onClick={toggleMenu}
            aria-expanded={isOpen}
            aria-controls="nav-menu"
            aria-label={isOpen ? "Close navigation menu" : "Open navigation menu"}
          >
            ☰
          </button>
          <ThemeToggle />
        </div>
        <div class="nav-brand">
          <img class="nav-brand-icon" src="icon-192.png" alt="Svarla icon" />
          <span class="nav-brand-text">Svarla</span>
        </div>
      </div>
      <ul
        id="nav-menu"
        class={`nav-links${isOpen ? " open" : ""}`}
        role="menubar"
      >
        {navItems.map((item) => (
          <li key={item.path} role="none">
            <a
              href={`#${item.path}`}
              role="menuitem"
              class={activePath === item.path ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                handleNavClick(item.path);
              }}
            >
  <span class="nav-icon">{item.icon}</span>
              {item.label}
            </a>
          </li>
        ))}
        {(props.openDialer || props.callingDisabledReason) && (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              class="nav-dial"
              onClick={handleDialClick}
              disabled={!props.openDialer}
              aria-label="Place a call"
              aria-disabled={!props.openDialer}
              title={props.callingDisabledReason ?? undefined}
            >
              <span class="nav-icon">{phoneIcon()}</span>
              Dial
            </button>
            {props.callingDisabledReason && (
              <p class="nav-dial-note" role="note">
                {props.callingDisabledReason}
              </p>
            )}
          </li>
        )}
      </ul>
    </nav>
  );
}
