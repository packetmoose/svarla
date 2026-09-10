import { h } from "preact";
import type { VNode } from "preact";
import { useState, useEffect } from "preact/hooks";
import { navigate } from "../router";
import { homeIcon, chatIcon, callIcon, settingsIcon } from "./icons";
import { api } from "../api";
import { getWebSocket, initWebSocket } from "../ws";
import {
  isConversationUnread,
  type Conversation,
} from "./conversations";
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
  { label: "Calls", path: "/call-history", icon: callIcon() },
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

interface ConversationsResponse {
  conversations: Conversation[];
}

/**
 * Track whether any conversation has unread inbound messages, kept live via the
 * same websocket signals the Conversations view uses. `new_message` may flip a
 * thread to unread, `read_state_updated` (another device read a thread) may
 * clear it, and `ws_connected` resyncs after a reconnect. Unread is derived with
 * the shared {@link isConversationUnread} so the nav dot and the per-thread dot
 * never disagree.
 */
function useUnreadConversations(): boolean {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await api.get<ConversationsResponse>("/api/conversations");
      if (cancelled || !result.ok) return;
      setHasUnread(result.data.conversations.some(isConversationUnread));
    };

    void refresh();

    const ws = getWebSocket() ?? initWebSocket();
    const unsubscribers = [
      ws.subscribe("new_message", () => void refresh()),
      ws.subscribe("read_state_updated", () => void refresh()),
      ws.subscribe("ws_connected", () => void refresh()),
    ];

    return () => {
      cancelled = true;
      for (const unsub of unsubscribers) unsub();
    };
  }, []);

  return hasUnread;
}

export function Nav() {
  const [isOpen, setIsOpen] = useState(false);
  const [activePath, setActivePath] = useState(getCurrentPath());
  const hasUnreadConversations = useUnreadConversations();

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
        {navItems.map((item) => {
          const showUnread =
            item.path === "/conversations" && hasUnreadConversations;
          return (
            <li key={item.path} role="none">
              <a
                href={`#${item.path}`}
                role="menuitem"
                class={activePath === item.path ? "active" : ""}
                aria-label={
                  showUnread ? `${item.label} (unread messages)` : undefined
                }
                onClick={(e) => {
                  e.preventDefault();
                  handleNavClick(item.path);
                }}
              >
                <span class="nav-icon">{item.icon}</span>
                {item.label}
                {showUnread && (
                  <span class="nav-unread-dot conversation-unread-dot" aria-hidden="true" />
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
