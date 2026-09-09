import { h, Component, Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { api } from "../api";
import { navigate } from "../router";
import { initWebSocket, getWebSocket } from "../ws";
import { openDialer, isDialerAvailable } from "../call/dialer-bridge";
import { callingUnavailableReason } from "../call/capability-guard";
import { phoneIcon } from "./icons";

/* ---------- Direction icons ---------- */

/**
 * Material-style outline icons rendered as inline SVG so they inherit the
 * current text color and stay pixel-consistent. Matches the convention used on
 * the Settings page: a 24px viewBox with 1.75 stroke weight.
 */
function iconSvg(children: ComponentChildren) {
  return (
    <svg
      class="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Per-call-type direction glyph. Inbound calls point down-left into the device,
 * outbound point up-right away from it, and the unanswered/missed family use a
 * variation that reads as "did not connect".
 */
function callTypeIcon(callType: CallHistoryEntry["callType"]) {
  switch (callType) {
    case "INCOMING":
      // Arrow pointing into the corner (received)
      return iconSvg(
        <Fragment>
          <path d="M7 17 17 7" />
          <path d="M8 7H7v10h10" />
        </Fragment>
      );
    case "OUTGOING":
      // Arrow pointing out to the corner (placed)
      return iconSvg(
        <Fragment>
          <path d="M7 17 17 7" />
          <path d="M9 7h8v8" />
        </Fragment>
      );
    case "MISSED":
      // Inbound arrow with the "missed" slash feel — down-left
      return iconSvg(
        <Fragment>
          <path d="M17 7 7 17" />
          <path d="M8 11v6h6" />
        </Fragment>
      );
    case "DECLINED":
      // Circle with a slash
      return iconSvg(
        <Fragment>
          <circle cx="12" cy="12" r="8" />
          <path d="M6.5 6.5 17.5 17.5" />
        </Fragment>
      );
    case "UNANSWERED":
      // Clock — rang out
      return iconSvg(
        <Fragment>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </Fragment>
      );
    case "BLOCKED":
      // Minus in a circle
      return iconSvg(
        <Fragment>
          <circle cx="12" cy="12" r="8" />
          <path d="M8 12h8" />
        </Fragment>
      );
    default:
      return iconSvg(<circle cx="12" cy="12" r="8" />);
  }
}

/* ---------- Row action icons ---------- */

function messageIcon() {
  // Speech bubble — start / open an SMS conversation
  return iconSvg(
    <path d="M21 11.5a8.5 8.5 0 0 1-11.9 7.8L3 21l1.7-6.1A8.5 8.5 0 1 1 21 11.5z" />
  );
}

/**
 * A phone number is messageable only if it is a real dialable number. Non-numeric
 * sender IDs (alphanumeric brand names, "Anonymous", etc.) can't be replied to —
 * mirrors the isNumericNumber gate used by the conversations composer.
 */
function isMessageable(number: string): boolean {
  return /^\+?\d+$/.test(number);
}

interface CallHistoryEntry {
  id: string;
  phoneNumber: string;
  providerNumber: string | null;
  callType: "INCOMING" | "OUTGOING" | "MISSED" | "DECLINED" | "UNANSWERED" | "BLOCKED";
  timestamp: string;
  durationSeconds: number | null;
  providerCallId: string | null;
  answeredByDevice: string | null;
}

interface CallHistoryResponse {
  entries: CallHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface NumberInfo {
  number: string;
  label: string | null;
  color: string | null;
  isActive: boolean;
}

/** Fallback provider color, matching the Android app and the numbers page. */
const DEFAULT_NUMBER_COLOR = "#6750A4";

interface NumbersResponse {
  numbers: NumberInfo[];
  defaultNumber: string | null;
}

interface CallHistoryState {
  entries: CallHistoryEntry[];
  loading: boolean;
  error: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  numberLabels: Record<string, string>;
  numberColors: Record<string, string>;
  availableNumbers: NumberInfo[];
  filterNumber: string;
}

const PAGE_SIZE = 20;

export class CallHistory extends Component<
  Record<string, never>,
  CallHistoryState
> {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeNumbers: (() => void) | null = null;
  private unsubscribeNumberLabel: (() => void) | null = null;
  private unsubscribeConnected: (() => void) | null = null;

  state: CallHistoryState = {
    entries: [],
    loading: true,
    error: "",
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 0,
    numberLabels: {},
    numberColors: {},
    availableNumbers: [],
    filterNumber: "",
  };

  componentDidMount() {
    this.fetchHistory(1);
    this.fetchNumberLabels();
    this.subscribeToUpdates();
  }

  componentWillUnmount() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.unsubscribeNumbers) {
      this.unsubscribeNumbers();
      this.unsubscribeNumbers = null;
    }
    if (this.unsubscribeNumberLabel) {
      this.unsubscribeNumberLabel();
      this.unsubscribeNumberLabel = null;
    }
    if (this.unsubscribeConnected) {
      this.unsubscribeConnected();
      this.unsubscribeConnected = null;
    }
  }

  private subscribeToUpdates() {
    let ws = getWebSocket();
    if (!ws) {
      ws = initWebSocket();
    }
    this.unsubscribe = ws.subscribe(
      "call_history_update",
      (data: unknown) => {
        // Server sends snake_case fields directly; map to camelCase
        const raw = data as Record<string, unknown>;
        if (!raw || !raw.id) return;
        const entry: CallHistoryEntry = {
          id: raw.id as string,
          phoneNumber: (raw.phoneNumber ?? raw.phone_number ?? "") as string,
          providerNumber: (raw.providerNumber ?? raw.provider_number ?? null) as string | null,
          callType: (raw.callType ?? raw.call_type ?? "INCOMING") as CallHistoryEntry["callType"],
          timestamp: (raw.timestamp ?? "") as string,
          durationSeconds: (raw.durationSeconds ?? raw.duration_seconds ?? null) as number | null,
          providerCallId: (raw.providerCallId ?? raw.provider_call_id ?? null) as string | null,
          answeredByDevice: (raw.answeredByDevice ?? raw.answered_by_device ?? null) as string | null,
        };
        this.handleRealtimeUpdate(entry);
      }
    );
    this.unsubscribeNumbers = ws.subscribe(
      "numbers_changed",
      () => {
        // The broadcast payload carries only *active* numbers, but the filter
        // must keep offering deactivated numbers that still have call-history
        // entries. Re-fetch the full list (GET /api/numbers → getAllNumbers,
        // which includes inactive numbers) so a live deactivate/activate toggle
        // doesn't drop the number from the dropdown.
        this.fetchNumberLabels();
      }
    );
    this.unsubscribeNumberLabel = ws.subscribe(
      "number_label_updated",
      (data: unknown) => {
        const event = data as { number: string; label: string };
        if (event && event.number && event.label) {
          this.setState((prev) => ({
            numberLabels: { ...prev.numberLabels, [event.number]: event.label },
          }));
        }
      }
    );
    this.unsubscribeConnected = ws.subscribe(
      "ws_connected",
      () => {
        // Re-fetch data on WebSocket reconnect to pick up anything missed
        this.fetchHistory(this.state.page);
        this.fetchNumberLabels();
      }
    );
  }

  private handleRealtimeUpdate(entry: CallHistoryEntry) {
    this.setState((prev) => {
      const existingIndex = prev.entries.findIndex((e) => e.id === entry.id);

      let updatedEntries: CallHistoryEntry[];

      if (existingIndex >= 0) {
        // Update existing entry
        updatedEntries = [...prev.entries];
        updatedEntries[existingIndex] = entry;
      } else {
        // Insert new entry at the top (most recent first) if on page 1
        if (prev.page === 1) {
          updatedEntries = [entry, ...prev.entries].slice(0, prev.pageSize);
        } else {
          updatedEntries = prev.entries;
        }
      }

      return {
        entries: updatedEntries,
        total: existingIndex >= 0 ? prev.total : prev.total + 1,
        totalPages: Math.ceil(
          (existingIndex >= 0 ? prev.total : prev.total + 1) / prev.pageSize
        ),
      };
    });
  }

  private async fetchHistory(page: number) {
    this.setState({ loading: true, error: "" });

    const { filterNumber } = this.state;
    let url = `/api/calls/history?page=${page}&pageSize=${PAGE_SIZE}`;
    if (filterNumber) {
      url += `&providerNumber=${encodeURIComponent(filterNumber)}`;
    }

    const result = await api.get<CallHistoryResponse>(url);

    if (!result.ok) {
      this.setState({
        loading: false,
        error: "Failed to load calls",
      });
      return;
    }

    this.setState({
      entries: result.data.entries,
      page: result.data.page,
      pageSize: result.data.pageSize,
      total: result.data.total,
      totalPages: result.data.totalPages,
      loading: false,
    });
  }

  private async fetchNumberLabels() {
    // includeOrphaned=true so the filter also lists numbers whose provider was
    // removed but which still have call-history entries. Other consumers of
    // /api/numbers keep the default (live-provider) behavior.
    const result = await api.get<NumbersResponse>("/api/numbers?includeOrphaned=true");
    if (result.ok) {
      const labels: Record<string, string> = {};
      const colors: Record<string, string> = {};
      for (const n of result.data.numbers) {
        if (n.label) {
          labels[n.number] = n.label;
        }
        colors[n.number] = n.color || DEFAULT_NUMBER_COLOR;
      }
      this.setState({ numberLabels: labels, numberColors: colors, availableNumbers: result.data.numbers });
    }
  }

  private handlePreviousPage = () => {
    if (this.state.page > 1) {
      this.fetchHistory(this.state.page - 1);
    }
  };

  private handleNextPage = () => {
    if (this.state.page < this.state.totalPages) {
      this.fetchHistory(this.state.page + 1);
    }
  };

  private handleFilterChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    this.setState({ filterNumber: target.value }, () => {
      this.fetchHistory(1);
    });
  };

  private formatTimestamp(isoString: string): string {
    const date = new Date(isoString);
    // EU-style date (day-month-year) with a 24-hour clock. en-GB gives the
    // day-first ordering; hour12: false forces 24-hour time regardless of the
    // browser's locale defaults.
    return date.toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  private formatDuration(seconds: number | null): string {
    if (seconds == null || seconds <= 0) {
      return "0:00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  private getCallTypeBadge(
    callType: CallHistoryEntry["callType"]
  ): { label: string; className: string } {
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

  private getProviderNumberDisplay(providerNumber: string | null): string | null {
    if (!providerNumber) return null;
    const label = this.state.numberLabels[providerNumber];
    return label || providerNumber;
  }

  private getProviderNumberColor(providerNumber: string | null): string | null {
    if (!providerNumber) return null;
    return this.state.numberColors[providerNumber] || DEFAULT_NUMBER_COLOR;
  }

  // Deep-link into the conversation with this caller. A thread is keyed by the
  // (provider number, caller number) pair, so we pass both: `to` is the other
  // party and `from` is our own provider number. Conversations reads these on
  // mount and opens exactly that thread.
  private handleMessageClick = (phoneNumber: string, providerNumber: string | null) => {
    let path = `/conversations?to=${encodeURIComponent(phoneNumber)}`;
    if (providerNumber) {
      path += `&from=${encodeURIComponent(providerNumber)}`;
    }
    navigate(path);
  };

  // "Call back" opens the nav-launched Dialer pre-filled with this caller's
  // number (Requirement 17.2). CallHistory is router-rendered and receives no
  // App props, so it routes through the module-level dialer bridge that
  // main.tsx registers the App's opener into — the same open path as the nav
  // "dial" affordance.
  private handleCallBackClick = (phoneNumber: string) => {
    openDialer(phoneNumber);
  };

  // The page header: the title on the left and a "Dial" action on the right.
  // Placing Dial here (rather than in the nav) matches the mental model of
  // opening Calls, glancing at recent activity, then dialing. The button opens
  // the same nav-launched Dialer overlay via the dialer bridge. When calling is
  // unavailable in this browsing context the button is DISABLED and carries the
  // reason as its tooltip/announcement, so the entry point is always visible
  // and self-explanatory (Requirements 15.2, 15.3).
  private renderHeader() {
    const dialAvailable = isDialerAvailable();
    const disabledReason = dialAvailable ? undefined : callingUnavailableReason() ?? undefined;

    return (
      <div class="call-history-header">
        <h1 class="call-history-page-title">Calls</h1>
        <button
          type="button"
          class="btn btn-primary call-history-dial"
          onClick={() => openDialer()}
          disabled={!dialAvailable}
          aria-disabled={!dialAvailable}
          aria-label="Place a call"
          title={disabledReason}
        >
          <span class="call-history-dial-icon" aria-hidden="true">
            {phoneIcon(18)}
          </span>
          <span>Dial</span>
        </button>
      </div>
    );
  }

  render() {
    const { entries, loading, error, page, totalPages, availableNumbers, filterNumber } = this.state;

    if (loading && entries.length === 0) {
      return (
        <div class="call-history-container" role="main">
          {this.renderHeader()}
          <p class="loading-text" aria-live="polite">
            Loading calls...
          </p>
        </div>
      );
    }

    return (
      <div class="call-history-container" role="main">
        {this.renderHeader()}

        {availableNumbers.length > 0 && (
          <div class="call-history-filter">
            <label htmlFor="filter-provider-number">Filter by number</label>
            <select
              id="filter-provider-number"
              value={filterNumber}
              onChange={this.handleFilterChange}
              class="filter-select"
              aria-label="Filter by provider number"
            >
              <option value="">All numbers</option>
              {availableNumbers.map((n) => {
                const base = n.label ? `${n.label} (${n.number})` : n.number;
                return (
                  <option key={n.number} value={n.number}>
                    {n.isActive ? base : `${base} — disabled`}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {error && (
          <div class="call-history-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {entries.length === 0 && !error && (
          <div class="call-history-empty" aria-live="polite">
            <span class="call-history-empty-icon" aria-hidden="true">
              {callTypeIcon("MISSED")}
            </span>
            <p class="call-history-empty-title">No calls yet</p>
            <p class="call-history-empty-subtitle">
              Call activity will appear here as it happens.
            </p>
          </div>
        )}

        {entries.length > 0 && (
          <ul class="call-history-list" aria-label="Calls">
            {entries.map((entry) => {
              const badge = this.getCallTypeBadge(entry.callType);
              const providerDisplay = this.getProviderNumberDisplay(entry.providerNumber);
              const providerColor = this.getProviderNumberColor(entry.providerNumber);
              const hasDuration = entry.durationSeconds != null && entry.durationSeconds > 0;
              return (
                <li key={entry.id} class="call-history-entry">
                  <span
                    class={`call-direction-icon ${badge.className}`}
                    aria-hidden="true"
                  >
                    {callTypeIcon(entry.callType)}
                  </span>
                  <div class="call-entry-main">
                    <span class="call-phone-number">{entry.phoneNumber}</span>
                    <div class="call-entry-meta">
                      <span class="call-timestamp">
                        {this.formatTimestamp(entry.timestamp)}
                      </span>
                      {hasDuration && (
                        <span class="call-duration">
                          {this.formatDuration(entry.durationSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="call-entry-side">
                    <span class={`call-type-badge ${badge.className}`}>
                      {badge.label}
                    </span>
                    {providerDisplay && (
                      <span class="call-provider-number" title={`via ${providerDisplay}`}>
                        <span class="call-provider-label">{providerDisplay}</span>
                        <span
                          class="call-provider-dot"
                          style={{ backgroundColor: providerColor || "#6750A4" }}
                          aria-hidden="true"
                        />
                      </span>
                    )}
                  </div>
                  <div class="call-entry-actions">
                    {/* "Call back" pre-fills the Dialer with this number. Only
                        shown when the browser supports calling (the bridge has
                        a registered opener) and the number is dialable. */}
                    {isDialerAvailable() && isMessageable(entry.phoneNumber) && (
                      <button
                        type="button"
                        class="call-action-btn"
                        onClick={() => this.handleCallBackClick(entry.phoneNumber)}
                        aria-label={`Call back ${entry.phoneNumber}`}
                        title={`Call back ${entry.phoneNumber}`}
                      >
                        {phoneIcon()}
                      </button>
                    )}
                    {(() => {
                      const messageable = isMessageable(entry.phoneNumber);
                      return (
                        <button
                          type="button"
                          class={`call-action-btn${messageable ? "" : " call-action-btn-disabled"}`}
                          onClick={
                            messageable
                              ? () => this.handleMessageClick(entry.phoneNumber, entry.providerNumber)
                              : undefined
                          }
                          disabled={!messageable}
                          aria-label={
                            messageable
                              ? `Message ${entry.phoneNumber}`
                              : `${entry.phoneNumber} can't be messaged`
                          }
                          title={
                            messageable
                              ? `Message ${entry.phoneNumber}`
                              : "This sender can't be messaged"
                          }
                        >
                          {messageIcon()}
                        </button>
                      );
                    })()}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {totalPages > 1 && (
          <div class="call-history-pagination" aria-label="Pagination controls">
            <button
              class="btn-pagination"
              onClick={this.handlePreviousPage}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              Previous
            </button>
            <span class="pagination-info">
              Page {page} of {totalPages}
            </span>
            <button
              class="btn-pagination"
              onClick={this.handleNextPage}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              Next
            </button>
          </div>
        )}
      </div>
    );
  }
}
