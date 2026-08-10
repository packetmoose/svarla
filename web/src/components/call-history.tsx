import { h, Component } from "preact";
import { api } from "../api";
import { initWebSocket, getWebSocket } from "../ws";

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
}

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
      (data: unknown) => {
        const event = data as { numbers: NumberInfo[] };
        if (event && event.numbers) {
          const labels: Record<string, string> = {};
          for (const n of event.numbers) {
            if (n.label) {
              labels[n.number] = n.label;
            }
          }
          this.setState({ numberLabels: labels });
        }
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
        error: "Failed to load call history",
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
    const result = await api.get<NumbersResponse>("/api/numbers");
    if (result.ok) {
      const labels: Record<string, string> = {};
      for (const n of result.data.numbers) {
        if (n.label) {
          labels[n.number] = n.label;
        }
      }
      this.setState({ numberLabels: labels, availableNumbers: result.data.numbers });
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
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
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

  render() {
    const { entries, loading, error, page, totalPages, availableNumbers, filterNumber } = this.state;

    if (loading && entries.length === 0) {
      return (
        <div class="call-history-container" role="main">
          <h1>Call History</h1>
          <p class="loading-text" aria-live="polite">
            Loading call history...
          </p>
        </div>
      );
    }

    return (
      <div class="call-history-container" role="main">
        <h1>Call History</h1>

        {availableNumbers.length > 0 && (
          <div class="call-history-filter">
            <label htmlFor="filter-provider-number">Filter by number:</label>
            <select
              id="filter-provider-number"
              value={filterNumber}
              onChange={this.handleFilterChange}
              class="filter-select"
              aria-label="Filter by provider number"
            >
              <option value="">All numbers</option>
              {availableNumbers.map((n) => (
                <option key={n.number} value={n.number}>
                  {n.label ? `${n.label} (${n.number})` : n.number}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div class="call-history-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {entries.length === 0 && !error && (
          <p class="call-history-empty" aria-live="polite">
            No calls recorded
          </p>
        )}

        {entries.length > 0 && (
          <ul class="call-history-list" aria-label="Call history entries">
            {entries.map((entry) => {
              const badge = this.getCallTypeBadge(entry.callType);
              const providerDisplay = this.getProviderNumberDisplay(entry.providerNumber);
              return (
                <li key={entry.id} class="call-history-entry">
                  <div class="call-entry-header">
                    <span class={`call-type-badge ${badge.className}`}>
                      {badge.label}
                    </span>
                    <span class="call-phone-number">{entry.phoneNumber}</span>
                  </div>
                  <div class="call-entry-details">
                    <span class="call-timestamp">
                      {this.formatTimestamp(entry.timestamp)}
                    </span>
                    <span class="call-duration">
                      {this.formatDuration(entry.durationSeconds)}
                    </span>
                  </div>
                  {providerDisplay && (
                    <div class="call-entry-provider">
                      <span class="call-provider-number">
                        via {providerDisplay}
                      </span>
                    </div>
                  )}
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
