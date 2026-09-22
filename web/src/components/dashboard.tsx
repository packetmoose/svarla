import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import { api } from "../api";
import { navigate } from "../router";
import { getWebSocket, initWebSocket } from "../ws";
import { chatIcon, phoneIcon } from "./icons";
import { openDialer, isDialerAvailable } from "../call/dialer-bridge";
import { isConversationUnread, type Conversation } from "./conversations";

/** How many items to show in each activity section. */
const RECENT_LIMIT = 5;

/* ---------------------------------------------------------------- Types --- */

interface ConversationsResponse {
  conversations: Conversation[];
}

interface CallHistoryEntry {
  id: string;
  phoneNumber: string;
  providerNumber: string | null;
  callType:
    | "INCOMING"
    | "OUTGOING"
    | "MISSED"
    | "DECLINED"
    | "UNANSWERED"
    | "BLOCKED";
  timestamp: string;
  durationSeconds: number | null;
}

interface CallHistoryResponse {
  entries: CallHistoryEntry[];
}

interface NumberInfo {
  number: string;
  label: string | null;
  color: string | null;
}

interface NumbersResponse {
  numbers: NumberInfo[];
}

/** Fallback provider color, matching the numbers page and Android app. */
const DEFAULT_NUMBER_COLOR = "#6750A4";

/**
 * Provider-number metadata lookups: the colored dot's fill and the hover
 * label/number, both keyed by the provider number. Mirrors the maps built on
 * the Calls and Conversations pages so the dot and tooltip stay consistent
 * across views.
 */
interface ProviderNumbers {
  color(providerNumber: string | null): string | null;
  display(providerNumber: string | null): string | null;
}

/* ------------------------------------------------------------- Helpers --- */

/**
 * Compact "time ago" formatting for the activity lists — recent items read as
 * relative ("5m", "2h"), older ones fall back to a short date. Keeps each row
 * terse so the dashboard stays scannable rather than mirroring the full,
 * verbose timestamps used on the Calls/Conversations pages.
 */
function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diffMs < min) return "now";
  if (diffMs < hour) return `${Math.floor(diffMs / min)}m`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d`;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** A number is dialable/messageable only if it's a real numeric number. */
function isNumeric(number: string): boolean {
  return /^\+?\d+$/.test(number);
}

/** Full, human date+time for the hover tooltip (24-hour, EU-style). */
function formatAbsolute(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** m:ss call duration, or null when there's nothing meaningful to show. */
function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function truncate(text: string | null, maxLen: number): string {
  if (!text) return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

/** A single label/value pair shown in a row's hover tooltip. */
type TooltipField = [label: string, value: string | null | undefined];

/**
 * A styled hover/focus tooltip that matches the rest of the page (surface
 * panel, outline, elevation) instead of the browser's native `title` bubble.
 * Renders the row's details as aligned label/value rows; empty values are
 * dropped so a row without, say, a provider number stays tidy. It's decorative
 * for assistive tech (the row's own aria-label carries the essentials), and is
 * shown purely via CSS on `.dashboard-row:hover`/`:focus`.
 */
function RowTooltip({ fields }: { fields: TooltipField[] }) {
  const rows = fields.filter(([, value]) => value != null && value !== "");
  if (rows.length === 0) return null;
  return (
    <span class="dashboard-tooltip" role="presentation" aria-hidden="true">
      {rows.map(([label, value]) => (
        <span class="dashboard-tooltip-row" key={label}>
          <span class="dashboard-tooltip-label">{label}</span>
          <span class="dashboard-tooltip-value">{value}</span>
        </span>
      ))}
    </span>
  );
}

/** Deep link into a specific conversation thread (keyed by provider + peer). */
function conversationHref(conv: Conversation): string {
  let path = `/conversations?to=${encodeURIComponent(conv.phoneNumber)}`;
  if (conv.providerNumber) {
    path += `&from=${encodeURIComponent(conv.providerNumber)}`;
  }
  return path;
}

/** Per-call-type glyph + label + badge class, mirroring the Calls page. */
function callMeta(callType: CallHistoryEntry["callType"]): {
  label: string;
  className: string;
} {
  switch (callType) {
    case "INCOMING":
      return { label: "Incoming", className: "badge-incoming" };
    case "OUTGOING":
      return { label: "Outgoing", className: "badge-outgoing" };
    case "MISSED":
      return { label: "Missed", className: "badge-missed" };
    case "DECLINED":
      return { label: "Declined", className: "badge-declined" };
    case "UNANSWERED":
      return { label: "Unanswered", className: "badge-unanswered" };
    case "BLOCKED":
      return { label: "Blocked", className: "badge-blocked" };
    default:
      return { label: callType, className: "badge-default" };
  }
}

/* ------------------------------------------------------------- Section --- */

interface SectionProps {
  title: string;
  viewAllPath: string;
  viewAllLabel: string;
  loading: boolean;
  empty: boolean;
  emptyText: string;
  children?: preact.ComponentChildren;
}

function ActivitySection({
  title,
  viewAllPath,
  viewAllLabel,
  loading,
  empty,
  emptyText,
  children,
}: SectionProps) {
  return (
    <section class="dashboard-section" aria-label={title}>
      <div class="dashboard-section-header">
        <h2 class="dashboard-section-title">{title}</h2>
        <a
          href={`#${viewAllPath}`}
          class="dashboard-view-all"
          onClick={(e) => {
            e.preventDefault();
            navigate(viewAllPath);
          }}
        >
          {viewAllLabel}
        </a>
      </div>
      {loading ? (
        <p class="dashboard-section-loading" aria-live="polite">
          Loading…
        </p>
      ) : empty ? (
        <p class="dashboard-section-empty">{emptyText}</p>
      ) : (
        children
      )}
    </section>
  );
}

/* --------------------------------------------------------- Data hooks --- */

/**
 * The most-recent conversation threads, sorted by last activity and kept live
 * via the same websocket signals the Conversations view uses (new messages,
 * cross-device read-state changes, and reconnects).
 */
function useRecentConversations(): { items: Conversation[]; loading: boolean } {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const result = await api.get<ConversationsResponse>("/api/conversations");
    if (!result.ok) {
      setLoading(false);
      return;
    }
    const sorted = [...result.data.conversations].sort((a, b) => {
      const ta = a.lastMessageTimestamp
        ? new Date(a.lastMessageTimestamp).getTime()
        : 0;
      const tb = b.lastMessageTimestamp
        ? new Date(b.lastMessageTimestamp).getTime()
        : 0;
      return tb - ta;
    });
    setItems(sorted.slice(0, RECENT_LIMIT));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const ws = getWebSocket() ?? initWebSocket();
    const unsubs = [
      ws.subscribe("new_message", () => void refresh()),
      ws.subscribe("read_state_updated", () => void refresh()),
      ws.subscribe("ws_connected", () => void refresh()),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [refresh]);

  return { items, loading };
}

/**
 * The most-recent calls, kept live via the `call_history_update` broadcast (a
 * new/updated call) and resynced on reconnect. Only the newest {@link
 * RECENT_LIMIT} are held — this is a glance, not the full paginated history.
 */
function useRecentCalls(): { items: CallHistoryEntry[]; loading: boolean } {
  const [items, setItems] = useState<CallHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const result = await api.get<CallHistoryResponse>(
      `/api/calls/history?page=1&pageSize=${RECENT_LIMIT}`,
    );
    if (!result.ok) {
      setLoading(false);
      return;
    }
    setItems(result.data.entries.slice(0, RECENT_LIMIT));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const ws = getWebSocket() ?? initWebSocket();
    const unsubs = [
      ws.subscribe("call_history_update", () => void refresh()),
      ws.subscribe("ws_connected", () => void refresh()),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [refresh]);

  return { items, loading };
}

/**
 * Provider-number color/label lookups, kept live via the same signals the other
 * views use: `numbers_changed` (a number added/removed/recolored) and
 * `number_label_updated` (a label edited).
 */
function useProviderNumbers(): ProviderNumbers {
  const [colors, setColors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const result = await api.get<NumbersResponse>("/api/numbers");
    if (!result.ok) return;
    const nextColors: Record<string, string> = {};
    const nextLabels: Record<string, string> = {};
    for (const n of result.data.numbers) {
      nextColors[n.number] = n.color || DEFAULT_NUMBER_COLOR;
      if (n.label) nextLabels[n.number] = n.label;
    }
    setColors(nextColors);
    setLabels(nextLabels);
  }, []);

  useEffect(() => {
    void refresh();
    const ws = getWebSocket() ?? initWebSocket();
    const unsubs = [
      ws.subscribe("numbers_changed", () => void refresh()),
      ws.subscribe("number_label_updated", () => void refresh()),
      ws.subscribe("ws_connected", () => void refresh()),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [refresh]);

  return {
    color: (providerNumber) =>
      providerNumber ? colors[providerNumber] || DEFAULT_NUMBER_COLOR : null,
    display: (providerNumber) =>
      providerNumber ? labels[providerNumber] || providerNumber : null,
  };
}

/**
 * A small colored dot marking which of your provider numbers the conversation
 * or call is on, pinned to the far-right slot so the dots line up vertically
 * across rows. The number's details are surfaced through the row's own tooltip
 * (see the row `title`), so the dot is decorative here. When there's no
 * provider number an empty placeholder keeps the column aligned.
 */
function ProviderDot({
  providerNumber,
  numbers,
}: {
  providerNumber: string | null;
  numbers: ProviderNumbers;
}) {
  const color = numbers.color(providerNumber);
  if (!providerNumber || !color) {
    return <span class="dashboard-provider-dot dashboard-provider-dot-empty" aria-hidden="true" />;
  }
  return (
    <span
      class="dashboard-provider-dot"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

/* ----------------------------------------------------------- Component --- */

export function Dashboard() {
  const { items: conversations, loading: convLoading } =
    useRecentConversations();
  const { items: calls, loading: callsLoading } = useRecentCalls();
  const numbers = useProviderNumbers();

  const dialAvailable = isDialerAvailable();

  return (
    <div class="dashboard">
      <div class="dashboard-header">
        <h1 class="dashboard-title">Dashboard</h1>
        <div class="dashboard-quick-actions">
          <button
            type="button"
            class="btn btn-primary dashboard-action"
            onClick={() => navigate("/conversations")}
          >
            <span class="dashboard-action-icon" aria-hidden="true">
              {chatIcon(18)}
            </span>
            New message
          </button>
          <button
            type="button"
            class="btn btn-secondary dashboard-action"
            onClick={() => openDialer()}
            disabled={!dialAvailable}
            aria-disabled={!dialAvailable}
            title={dialAvailable ? undefined : "Calling isn't available here"}
          >
            <span class="dashboard-action-icon" aria-hidden="true">
              {phoneIcon(18)}
            </span>
            Dial
          </button>
        </div>
      </div>

      <div class="dashboard-sections">
        <ActivitySection
          title="Recent conversations"
          viewAllPath="/conversations"
          viewAllLabel="View all"
          loading={convLoading}
          empty={conversations.length === 0}
          emptyText="No conversations yet."
        >
          <ul class="dashboard-list" aria-label="Recent conversations">
            {conversations.map((conv) => {
              const unread = isConversationUnread(conv);
              const href = conversationHref(conv);
              const tooltip: TooltipField[] = [
                ["Contact", conv.phoneNumber],
                ["Via", numbers.display(conv.providerNumber)],
                ["Last message", conv.lastMessagePreview],
                ["When", formatAbsolute(conv.lastMessageTimestamp)],
                ["Status", unread ? "Unread" : null],
              ];
              return (
                <li
                  key={`${conv.providerNumber ?? ""}|${conv.phoneNumber}`}
                  class="dashboard-list-item"
                >
                  <a
                    href={`#${href}`}
                    class={`dashboard-row${unread ? " dashboard-row-unread" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(href);
                    }}
                    aria-label={
                      unread
                        ? `${conv.phoneNumber} (unread)`
                        : conv.phoneNumber
                    }
                  >
                    <RowTooltip fields={tooltip} />
                    <span class="dashboard-row-icon" aria-hidden="true">
                      {chatIcon(18)}
                    </span>
                    <span class="dashboard-row-main">
                      <span class="dashboard-row-title">
                        {conv.phoneNumber}
                      </span>
                      <span class="dashboard-row-subtitle">
                        {truncate(conv.lastMessagePreview, 48) ||
                          "No messages yet"}
                      </span>
                    </span>
                    <span class="dashboard-row-time">
                      {formatRelative(conv.lastMessageTimestamp)}
                    </span>
                    <span class="dashboard-row-flag" aria-hidden="true">
                      {unread && (
                        <span class="dashboard-unread-dot conversation-unread-dot" />
                      )}
                    </span>
                    <ProviderDot
                      providerNumber={conv.providerNumber}
                      numbers={numbers}
                    />
                  </a>
                </li>
              );
            })}
          </ul>
        </ActivitySection>

        <ActivitySection
          title="Recent calls"
          viewAllPath="/call-history"
          viewAllLabel="View all"
          loading={callsLoading}
          empty={calls.length === 0}
          emptyText="No calls yet."
        >
          <ul class="dashboard-list" aria-label="Recent calls">
            {calls.map((entry) => {
              const meta = callMeta(entry.callType);
              const callable = dialAvailable && isNumeric(entry.phoneNumber);
              const duration = formatDuration(entry.durationSeconds);
              const tooltip: TooltipField[] = [
                ["Contact", entry.phoneNumber],
                ["Type", meta.label],
                ["Via", numbers.display(entry.providerNumber)],
                ["When", formatAbsolute(entry.timestamp)],
                ["Duration", duration],
              ];
              return (
                <li key={entry.id} class="dashboard-list-item">
                  <button
                    type="button"
                    class="dashboard-row dashboard-row-button"
                    onClick={() =>
                      callable
                        ? openDialer(entry.phoneNumber)
                        : navigate("/call-history")
                    }
                    aria-label={
                      callable
                        ? `Call back ${entry.phoneNumber}`
                        : `${meta.label} call ${entry.phoneNumber}`
                    }
                  >
                    <RowTooltip fields={tooltip} />
                    <span
                      class={`dashboard-row-icon call-direction-icon ${meta.className}`}
                      aria-hidden="true"
                    >
                      {phoneIcon(18)}
                    </span>
                    <span class="dashboard-row-main">
                      <span class="dashboard-row-title">
                        {entry.phoneNumber}
                      </span>
                      <span class="dashboard-row-subtitle">
                        {meta.label}
                        {duration && (
                          <span class="dashboard-row-duration"> · {duration}</span>
                        )}
                      </span>
                    </span>
                    <span class="dashboard-row-time">
                      {formatRelative(entry.timestamp)}
                    </span>
                    <span class="dashboard-row-flag" aria-hidden="true" />
                    <ProviderDot
                      providerNumber={entry.providerNumber}
                      numbers={numbers}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </ActivitySection>
      </div>
    </div>
  );
}
