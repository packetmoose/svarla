import { h } from "preact";
import { navigate } from "../router";

interface DashboardItem {
  icon: string;
  title: string;
  description: string;
  path: string;
}

const items: DashboardItem[] = [
  {
    icon: "◬",
    title: "Conversations",
    description: "View and send SMS messages",
    path: "/conversations",
  },
  {
    icon: "↗",
    title: "Call History",
    description: "Recent incoming and outgoing calls",
    path: "/call-history",
  },
  {
    icon: "📥",
    title: "Download App",
    description: "Get the Svarla Android app",
    path: "/download",
  },
  {
    icon: "⚙",
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
