import { h } from "preact";
import type { VNode } from "preact";
import { navigate } from "../router";
import { chatIcon, callIcon, downloadIcon, settingsIcon } from "./icons";

/** Dashboard cards render icons a touch larger than the 20px nav/tab default. */
const CARD_ICON_SIZE = 28;

interface DashboardItem {
  icon: VNode;
  title: string;
  description: string;
  path: string;
}

const items: DashboardItem[] = [
  {
    icon: chatIcon(CARD_ICON_SIZE),
    title: "Conversations",
    description: "View and send SMS messages",
    path: "/conversations",
  },
  {
    icon: callIcon(CARD_ICON_SIZE),
    title: "Calls",
    description: "Recent calls, and place a new one",
    path: "/call-history",
  },
  {
    icon: downloadIcon(CARD_ICON_SIZE),
    title: "Download App",
    description: "Get the Svarla Android app",
    path: "/download",
  },
  {
    icon: settingsIcon(CARD_ICON_SIZE),
    title: "Settings",
    description: "Providers, numbers, devices, and account",
    path: "/settings",
  },
];

export function Dashboard() {
  function handleCardClick(path: string) {
    navigate(path);
  }

  return (
    <div class="dashboard">
      <h1>Welcome back</h1>
      <p class="dashboard-subtitle">Manage your phone from one place.</p>
      <div class="dashboard-grid">
        {items.map((item) => (
          <a
            key={item.path}
            href={`#${item.path}`}
            class="dashboard-card"
            onClick={(e) => {
              e.preventDefault();
              handleCardClick(item.path);
            }}
          >
            <div class="dashboard-card-icon">{item.icon}</div>
            <span class="dashboard-card-title">{item.title}</span>
            <span class="dashboard-card-description">{item.description}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
