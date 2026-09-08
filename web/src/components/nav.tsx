import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import { navigate } from "../router";
import {
  getResolvedTheme,
  toggleTheme,
  subscribeTheme,
  type ResolvedTheme,
} from "../theme";

interface NavItem {
  label: string;
  path: string;
  icon: string;
}

const navItems: NavItem[] = [
  { label: "Dashboard", path: "/", icon: "⌂" },
  { label: "Conversations", path: "/conversations", icon: "◬" },
  { label: "Call History", path: "/call-history", icon: "↗" },
  { label: "Settings", path: "/settings", icon: "⚙" },
];

function getCurrentPath(): string {
  const hash = window.location.hash;
  return hash ? hash.slice(1) : "/";
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

export function Nav() {
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
      </ul>
    </nav>
  );
}
