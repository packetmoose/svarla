import { h, Component } from "preact";
import { api } from "../api";
import { initWebSocket, getWebSocket } from "../ws";
import { backIcon, trashIcon, phoneIcon } from "./icons";
import { openDialer, isDialerAvailable } from "../call/dialer-bridge";

export interface Conversation {
  phoneNumber: string;
  providerNumber: string | null;
  lastMessagePreview: string | null;
  lastMessageTimestamp: string | null;
  lastReceivedAt: string | null;
  createdAt: string | null;
  lastReadAt: string | null;
}

/**
 * A conversation is uniquely identified by the (provider number, peer number)
 * pair — the same peer reached from two different own-numbers is two separate
 * threads. This mirrors the backend `threadKey` (`<provider>|<phone>`), with the
 * empty string standing in for an unknown/legacy provider number.
 */
function threadKey(providerNumber: string | null, phoneNumber: string): string {
  return `${providerNumber ?? ""}|${phoneNumber}`;
}

interface Message {
  id: string;
  conversation_number: string;
  provider_number: string | null;
  body: string;
  direction: "SENT" | "RECEIVED";
  status: "PENDING" | "SENT" | "DELIVERED" | "FAILED" | "QUEUED";
  timestamp: string;
}

interface NumberEntry {
  number: string;
  label: string | null;
  isActive: boolean;
  color: string | null;
}

interface ConversationsResponse {
  conversations: Conversation[];
}

interface MessagesResponse {
  messages: Message[];
}

/** Shape of POST /api/sms/send — message fields are returned at the top level. */
interface SendMessageResponse {
  id: string;
  conversationNumber: string;
  providerNumber: string | null;
  body: string;
  direction: Message["direction"];
  status: Message["status"];
  timestamp: string;
}

interface NumbersResponse {
  numbers: NumberEntry[];
}

interface ConversationsState {
  conversations: Conversation[];
  loading: boolean;
  error: string;
  selectedNumber: string | null;
  /** Own provider number for the open thread; part of the (from, to) key. */
  selectedProviderNumber: string | null;
  messages: Message[];
  messagesLoading: boolean;
  composeBody: string;
  sending: boolean;
  sendError: string;
  showNewConversation: boolean;
  newNumber: string;
  newNumberError: string;
  sourceNumbers: NumberEntry[];
  selectedSource: string;
  sourceLoading: boolean;
  filterNumber: string;
  numberLabels: Record<string, string>;
  numberColors: Record<string, string>;
  allNumbers: NumberEntry[];
  /** True while the delete-conversation confirmation dialog is shown. */
  confirmDelete: boolean;
  /** True while a delete request is in flight. */
  deleting: boolean;
}

function truncatePreview(text: string | null, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  // Matches the Android conversation list: time today, weekday this week, and a
  // European dd/MM/yyyy date otherwise. en-GB + hour12:false keeps it 24-hour.
  if (diffMs < dayMs) {
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  if (diffMs < 7 * dayMs) {
    return date.toLocaleDateString("en-GB", { weekday: "short" });
  }
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isValidE164(number: string): boolean {
  if (!number.startsWith("+")) return false;
  const digits = number.slice(1);
  if (digits.length < 1 || digits.length > 15) return false;
  return /^\d+$/.test(digits);
}

/**
 * Checks if a number is numeric (dialable). Non-numeric strings
 * represent custom sender names and cannot be replied to.
 */
function isNumericNumber(number: string): boolean {
  return /^\+?\d+$/.test(number);
}

/**
 * A thread is unread when a message was received after it was last read (or it
 * has never been read). Mirrors the Android list's timestamp-based detection.
 */
export function isConversationUnread(conv: Conversation): boolean {
  if (!conv.lastReceivedAt) return false;
  if (!conv.lastReadAt) return true;
  return new Date(conv.lastReceivedAt).getTime() > new Date(conv.lastReadAt).getTime();
}

/* ---------- Contact avatar (mirrors the Android ContactAvatar) ---------- */

/**
 * A display name is really a phone number (no contact resolved) when it's blank
 * or starts with a digit or '+'. Those get a neutral grey person-icon avatar,
 * matching the Android app.
 */
function isPhoneNumberDisplay(name: string): boolean {
  if (!name || name.trim() === "") return true;
  const first = name.trim()[0];
  return /[0-9+]/.test(first);
}

/** Up to two initials from a contact name, matching Android's extractInitials. */
function extractInitials(name: string): string {
  if (!name || name.trim() === "") return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }
  return "?";
}

/** Muted avatar palette, matching the Android app's avatarColorForName. */
const AVATAR_PALETTE = [
  "#5C6BC0", // Indigo
  "#26A69A", // Teal
  "#EF5350", // Red
  "#AB47BC", // Purple
  "#42A5F5", // Blue
  "#66BB6A", // Green
  "#FFA726", // Orange
  "#78909C", // Blue Grey
  "#EC407A", // Pink
  "#8D6E63", // Brown
];

/** Deterministic avatar color for a name (same hashing intent as Android). */
function avatarColorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const index = (hash & 0x7fffffff) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index];
}

/** Person glyph for unresolved (phone-number-only) contacts. */
function personIcon() {
  return (
    <svg
      class="avatar-person-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6z" />
    </svg>
  );
}

/**
 * Renders a circular contact avatar: a grey person icon when the name is just a
 * phone number, otherwise initials on a deterministic colored circle.
 */
function ContactAvatar({ displayName }: { displayName: string }) {
  if (isPhoneNumberDisplay(displayName)) {
    return (
      <span class="conversation-avatar conversation-avatar-unknown" aria-hidden="true">
        {personIcon()}
      </span>
    );
  }
  return (
    <span
      class="conversation-avatar"
      style={{ backgroundColor: avatarColorForName(displayName) }}
      aria-hidden="true"
    >
      {extractInitials(displayName)}
    </span>
  );
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "PENDING":
      return "⏳";
    case "SENT":
      return "✓";
    case "DELIVERED":
      return "✓✓";
    case "FAILED":
      return "✗";
    default:
      return "";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "FAILED":
      return "Failed";
    case "QUEUED":
      return "Queued";
    default:
      return status;
  }
}

const MAX_MESSAGE_LENGTH = 1600;

export class Conversations extends Component<Record<string, never>, ConversationsState> {
  state: ConversationsState = {
    conversations: [],
    loading: true,
    error: "",
    selectedNumber: null,
    selectedProviderNumber: null,
    messages: [],
    messagesLoading: false,
    composeBody: "",
    sending: false,
    sendError: "",
    showNewConversation: false,
    newNumber: "",
    newNumberError: "",
    sourceNumbers: [],
    selectedSource: "",
    sourceLoading: false,
    filterNumber: "",
    numberLabels: {},
    numberColors: {},
    allNumbers: [],
    confirmDelete: false,
    deleting: false,
  };

  private unsubNewMessage: (() => void) | null = null;
  private unsubMessageStatus: (() => void) | null = null;
  private unsubConnected: (() => void) | null = null;
  private unsubReadState: (() => void) | null = null;

  /** The scrollable messages viewport, so we can pin it to the newest message. */
  private messagesListRef: HTMLDivElement | null = null;
  /** Set after a fetch/open so the next render scrolls the thread to the bottom. */
  private scrollToBottomOnUpdate = false;

  componentDidMount() {
    this.fetchConversations();
    this.fetchNumberLabels();
    this.setupWebSocket();

    // Deep link: /conversations?to=<number> opens that thread directly (used by
    // the Call History "message" action).
    const hash = window.location.hash;
    const queryIndex = hash.indexOf("?");
    if (queryIndex !== -1) {
      const params = new URLSearchParams(hash.slice(queryIndex + 1));
      const to = params.get("to");
      const from = params.get("from");
      if (to) {
        this.fetchMessages(to, from);
      }
    }
  }

  componentWillUnmount() {
    if (this.unsubNewMessage) {
      this.unsubNewMessage();
      this.unsubNewMessage = null;
    }
    if (this.unsubMessageStatus) {
      this.unsubMessageStatus();
      this.unsubMessageStatus = null;
    }
    if (this.unsubConnected) {
      this.unsubConnected();
      this.unsubConnected = null;
    }
    if (this.unsubReadState) {
      this.unsubReadState();
      this.unsubReadState = null;
    }
  }

  componentDidUpdate(_prevProps: Record<string, never>, prevState: ConversationsState) {
    // After a thread is opened or its messages change, pin the viewport to the
    // newest message (which sits at the bottom, since messages are chronological).
    const openedThread =
      this.state.selectedNumber !== null && prevState.selectedNumber === null;
    // Only a new message (count increase) should pull the view down — a
    // status-only update (same count) must not yank the reader off their place.
    const gotNewMessage = this.state.messages.length > prevState.messages.length;
    const finishedLoading = prevState.messagesLoading && !this.state.messagesLoading;

    if (this.scrollToBottomOnUpdate || openedThread || gotNewMessage || finishedLoading) {
      this.scrollToBottomOnUpdate = false;
      this.scrollMessagesToBottom();
    }
  }

  /** Jump the messages viewport to the newest message at the bottom. */
  private scrollMessagesToBottom() {
    const el = this.messagesListRef;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private setupWebSocket() {
    const ws = getWebSocket() || initWebSocket();

    this.unsubNewMessage = ws.subscribe("new_message", (data: unknown) => {
      // The new_message event is a lightweight notification: it carries the
      // thread identity (conversationNumber = peer, providerNumber = own) plus a
      // messageId and direction, but not the body/timestamp. We resync the
      // authoritative data from the server rather than trusting the payload.
      const notification = data as {
        conversationNumber: string;
        providerNumber?: string | null;
        messageId: string;
        direction: string;
      };

      // Only touch the open thread when BOTH numbers match — a message to the
      // same peer on a different own-number is a different conversation and must
      // not disturb the thread currently on screen.
      const sameThread =
        !!this.state.selectedNumber &&
        notification.conversationNumber === this.state.selectedNumber &&
        threadKey(notification.providerNumber ?? null, notification.conversationNumber) ===
          threadKey(this.state.selectedProviderNumber, this.state.selectedNumber);

      // The thread is open on screen, so an inbound message here is effectively
      // already seen — mark it read immediately instead of waiting for the user
      // to re-enter the thread. (Outbound echoes carry direction SENT and never
      // affect unread state.) We AWAIT the read before re-fetching the list so
      // the fetched rows reflect the new lastReadAt and don't momentarily
      // re-show the unread dot (avoids a read/fetch race).
      void (async () => {
        if (sameThread) {
          this.refreshMessages(this.state.selectedNumber as string);
          if (notification.direction === "RECEIVED") {
            await this.markThreadRead(
              this.state.selectedNumber as string,
              this.state.selectedProviderNumber,
            );
          }
        }
        // Refresh the full conversation list (previews, timestamps, ordering).
        void this.fetchConversations();
      })();
    });

    this.unsubMessageStatus = ws.subscribe("message_status", (data: unknown) => {
      // Server broadcasts { messageId, status } — match that shape.
      const update = data as { messageId: string; status: string };
      const { messages } = this.state;

      const updatedMessages = messages.map((m) => {
        if (m.id === update.messageId) {
          return { ...m, status: update.status as Message["status"] };
        }
        return m;
      });

      this.setState({ messages: updatedMessages });
    });

    this.unsubConnected = ws.subscribe("ws_connected", () => {
      // Re-fetch data on WebSocket reconnect to pick up anything missed
      this.fetchConversations();
      if (this.state.selectedNumber) {
        this.fetchMessages(this.state.selectedNumber, this.state.selectedProviderNumber);
      }
    });

    // Another device marked something read; the event carries only global
    // counts, so re-fetch the list to pick up fresh per-thread lastReadAt.
    this.unsubReadState = ws.subscribe("read_state_updated", () => {
      this.fetchConversations();
    });
  }

  private async fetchConversations() {
    this.setState({ loading: true, error: "" });

    const { filterNumber } = this.state;
    let url = "/api/conversations";
    if (filterNumber) {
      url += `?providerNumber=${encodeURIComponent(filterNumber)}`;
    }

    const result = await api.get<ConversationsResponse>(url);

    if (!result.ok) {
      this.setState({ loading: false, error: "Failed to load conversations" });
      return;
    }

    // Sort by most recent message timestamp descending
    const sorted = [...result.data.conversations].sort((a, b) => {
      const timeA = a.lastMessageTimestamp
        ? new Date(a.lastMessageTimestamp).getTime()
        : 0;
      const timeB = b.lastMessageTimestamp
        ? new Date(b.lastMessageTimestamp).getTime()
        : 0;
      return timeB - timeA;
    });

    this.setState({ conversations: sorted, loading: false });
  }

  private async fetchNumberLabels() {
    const result = await api.get<NumbersResponse>("/api/numbers");
    if (result.ok) {
      const labels: Record<string, string> = {};
      const colors: Record<string, string> = {};
      for (const n of result.data.numbers) {
        if (n.label) {
          labels[n.number] = n.label;
        }
        colors[n.number] = n.color || "#6750A4";
      }
      this.setState({ numberLabels: labels, numberColors: colors, allNumbers: result.data.numbers });
    }
  }

  private handleFilterChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    this.setState({ filterNumber: target.value }, () => {
      this.fetchConversations();
    });
  };

  private getProviderNumberDisplay(providerNumber: string | null): string | null {
    if (!providerNumber) return null;
    const label = this.state.numberLabels[providerNumber];
    return label || providerNumber;
  }

  private async fetchMessages(phoneNumber: string, providerNumber: string | null = null) {
    this.setState({
      selectedNumber: phoneNumber,
      selectedProviderNumber: providerNumber,
      messagesLoading: true,
      messages: [],
      composeBody: "",
      sendError: "",
    });

    // Opening a thread clears its unread indicator (locally now, and on the
    // server so other devices and the badge counts stay in sync).
    void this.markThreadRead(phoneNumber, providerNumber);

    // A thread is keyed by (provider number, caller number). Pass `from` so a
    // recipient reached from two different own-numbers stays in separate threads.
    let messagesUrl = `/api/conversations/${encodeURIComponent(phoneNumber)}`;
    if (providerNumber) {
      messagesUrl += `?from=${encodeURIComponent(providerNumber)}`;
    }

    // Fetch messages and source numbers in parallel
    const [messagesResult, numbersResult] = await Promise.all([
      api.get<MessagesResponse>(messagesUrl),
      api.get<NumbersResponse>("/api/numbers"),
    ]);

    if (!messagesResult.ok) {
      this.setState({
        messagesLoading: false,
        error: "Failed to load messages",
      });
      return;
    }

    // Messages returned are most recent 100, ordered chronologically (oldest first)
    const sorted = [...messagesResult.data.messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Load source numbers for sending. Prefer the thread's own provider number
    // as the reply source so a reply goes back out from the same number.
    if (numbersResult.ok) {
      const activeNumbers = numbersResult.data.numbers.filter((n) => n.isActive);
      const preferredSource =
        providerNumber && activeNumbers.some((n) => n.number === providerNumber)
          ? providerNumber
          : activeNumbers.length > 0
            ? activeNumbers[0].number
            : "";
      this.setState({
        sourceNumbers: activeNumbers,
        selectedSource: preferredSource,
      });
    }

    // Opening a thread should land at the newest message.
    this.scrollToBottomOnUpdate = true;
    this.setState({ messages: sorted, messagesLoading: false });
  }

  /**
   * Mark a thread as read: optimistically clear its unread state in the list,
   * then tell the server (which broadcasts to other devices). The server keys
   * read state by the (provider, peer) pair, so `from` is required.
   */
  private async markThreadRead(phoneNumber: string, providerNumber: string | null) {
    // Only numeric providers form a real thread key the server accepts; skip
    // when we don't have a provider number (nothing to mark against).
    if (!providerNumber) return;

    // Optimistic: stamp lastReadAt=now on the matching row so the dot clears.
    const now = new Date().toISOString();
    this.setState((prev) => ({
      conversations: prev.conversations.map((c) =>
        c.phoneNumber === phoneNumber && c.providerNumber === providerNumber
          ? { ...c, lastReadAt: now }
          : c
      ),
    }));

    const url = `/api/read-state/messages/${encodeURIComponent(phoneNumber)}?from=${encodeURIComponent(providerNumber)}`;
    // A failure just leaves the server-side state to be reconciled on the next
    // list fetch. Awaited by callers that re-fetch the list right after, so the
    // fetched rows reflect the new read state (avoids a read/fetch race).
    try {
      await api.post(url, {});
    } catch {
      /* best-effort; reconciled on next fetch */
    }
  }

  /**
   * Reload the messages for an already-open thread without disturbing UI state
   * (compose text, selected source, loading flash). Used for live refresh when a
   * new_message notification arrives for the currently selected conversation.
   */
  private async refreshMessages(phoneNumber: string) {
    let url = `/api/conversations/${encodeURIComponent(phoneNumber)}`;
    if (this.state.selectedProviderNumber) {
      url += `?from=${encodeURIComponent(this.state.selectedProviderNumber)}`;
    }
    const result = await api.get<MessagesResponse>(url);

    if (!result.ok) {
      return;
    }

    // Guard against a thread switch that happened while the request was in flight.
    if (this.state.selectedNumber !== phoneNumber) {
      return;
    }

    const sorted = [...result.data.messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    this.setState({ messages: sorted });
  }

  private handleSelectConversation = (
    phoneNumber: string,
    providerNumber: string | null = null
  ) => {
    this.fetchMessages(phoneNumber, providerNumber);
  };

  private handleBackToList = () => {
    this.setState({
      selectedNumber: null,
      selectedProviderNumber: null,
      messages: [],
      composeBody: "",
      sendError: "",
      confirmDelete: false,
    });
  };

  /** Call the peer of the open thread via the shared Dialer (pre-filled). */
  private handleCallPeer = () => {
    const { selectedNumber } = this.state;
    if (selectedNumber) openDialer(selectedNumber);
  };

  private handleDeleteClick = () => {
    this.setState({ confirmDelete: true });
  };

  private handleDeleteCancel = () => {
    this.setState({ confirmDelete: false });
  };

  /**
   * Remove the open conversation thread (server-side soft delete via
   * DELETE /api/conversations/:number?from=<provider>), then drop it from the
   * list and return to the conversation list.
   */
  private handleDeleteConfirm = async () => {
    const { selectedNumber, selectedProviderNumber } = this.state;
    if (!selectedNumber) return;

    // The delete endpoint keys a thread by (provider number, peer) and requires
    // a provider number. Legacy threads with no provider number (only seen in
    // old dev data) can't be targeted, so surface a clear message instead of
    // firing a request the server will reject.
    if (!selectedProviderNumber) {
      this.setState({
        confirmDelete: false,
        sendError:
          "This conversation has no provider number and can't be removed from here.",
      });
      return;
    }

    this.setState({ deleting: true });

    const url = `/api/conversations/${encodeURIComponent(selectedNumber)}?from=${encodeURIComponent(selectedProviderNumber)}`;
    const result = await api.delete(url);

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      this.setState({
        deleting: false,
        confirmDelete: false,
        sendError: errorData.error || "Failed to delete conversation",
      });
      return;
    }

    // Drop the removed thread from the list and return to the list view.
    this.setState((prev) => ({
      conversations: prev.conversations.filter(
        (c) =>
          !(
            c.phoneNumber === selectedNumber &&
            c.providerNumber === selectedProviderNumber
          )
      ),
      deleting: false,
      confirmDelete: false,
      selectedNumber: null,
      selectedProviderNumber: null,
      messages: [],
      composeBody: "",
      sendError: "",
    }));
  };

  private handleComposeInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const value = target.value;
    if (value.length <= MAX_MESSAGE_LENGTH) {
      this.setState({ composeBody: value, sendError: "" });
    }
  };

  private handleSendMessage = async () => {
    const { composeBody, selectedNumber, sourceNumbers } = this.state;

    if (!selectedNumber || composeBody.length === 0 || composeBody.length > MAX_MESSAGE_LENGTH) {
      return;
    }

    // Prefer the thread's own provider number, then the explicit source
    // selection, then the first available number.
    const from =
      this.state.selectedProviderNumber ||
      this.state.selectedSource ||
      (sourceNumbers.length > 0 ? sourceNumbers[0].number : "");

    if (!from) {
      this.setState({ sendError: "No source number available" });
      return;
    }

    this.setState({ sending: true, sendError: "" });

    // POST /api/sms/send returns the created message fields at the top level
    // (camelCase), not wrapped in { message }.
    const result = await api.post<SendMessageResponse>("/api/sms/send", {
      to: selectedNumber,
      body: composeBody,
      from,
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      this.setState({
        sending: false,
        sendError: errorData.error || "Failed to send message",
      });
      return;
    }

    // Optimistically append the sent message so it shows immediately (and the
    // thread scrolls to it) rather than waiting for the WebSocket round-trip.
    const sent = result.data;
    if (sent && sent.id) {
      const message: Message = {
        id: sent.id,
        conversation_number: sent.conversationNumber,
        provider_number: sent.providerNumber,
        body: sent.body,
        direction: sent.direction,
        status: sent.status,
        timestamp: sent.timestamp,
      };
      this.setState((prev) => ({
        // Guard against a double-add if the WS refresh already delivered it.
        messages: prev.messages.some((m) => m.id === message.id)
          ? prev.messages
          : [...prev.messages, message],
        composeBody: "",
        sending: false,
      }));
    } else {
      this.setState({ composeBody: "", sending: false });
    }
  };

  private handleComposeKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSendMessage();
    }
  };

  private handleNewConversation = async () => {
    this.setState({
      showNewConversation: true,
      newNumber: "",
      newNumberError: "",
      sourceLoading: true,
    });

    const result = await api.get<NumbersResponse>("/api/numbers");

    if (result.ok) {
      const activeNumbers = result.data.numbers.filter((n) => n.isActive);
      this.setState({
        sourceNumbers: activeNumbers,
        selectedSource: activeNumbers.length > 0 ? activeNumbers[0].number : "",
        sourceLoading: false,
      });
    } else {
      this.setState({ sourceNumbers: [], sourceLoading: false });
    }
  };

  private handleCancelNew = () => {
    this.setState({
      showNewConversation: false,
      newNumber: "",
      newNumberError: "",
    });
  };

  private handleNewNumberInput = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ newNumber: target.value, newNumberError: "" });
  };

  private handleSourceChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    this.setState({ selectedSource: target.value });
  };

  private handleStartConversation = () => {
    const { newNumber, selectedSource } = this.state;

    if (!isValidE164(newNumber)) {
      this.setState({
        newNumberError:
          "Invalid phone number. Must start with + followed by 1-15 digits (E.164 format).",
      });
      return;
    }

    if (!selectedSource) {
      this.setState({ newNumberError: "Please select a source number" });
      return;
    }

    this.setState({
      showNewConversation: false,
      selectedNumber: newNumber,
      messages: [],
      messagesLoading: false,
      composeBody: "",
      sendError: "",
    });
  };

  private renderConversationList() {
    const { conversations, loading, error, showNewConversation, allNumbers, filterNumber } = this.state;

    if (loading) {
      return (
        <div class="conversations-container" role="main">
          <h1>Conversations</h1>
          <p class="loading-text" aria-live="polite">
            Loading conversations...
          </p>
        </div>
      );
    }

    return (
      <div class="conversations-container" role="main">
        <div class="conversations-header">
          <h1>Conversations</h1>
          <button
            type="button"
            class="btn btn-primary"
            onClick={this.handleNewConversation}
            aria-label="Start new conversation"
          >
            New Conversation
          </button>
        </div>

        {allNumbers.length > 0 && (
          <div class="conversations-filter">
            <label htmlFor="filter-provider-number">Filter by number:</label>
            <select
              id="filter-provider-number"
              value={filterNumber}
              onChange={this.handleFilterChange}
              class="filter-select"
              aria-label="Filter by provider number"
            >
              <option value="">All numbers</option>
              {allNumbers.map((n) => (
                <option key={n.number} value={n.number}>
                  {n.label ? `${n.label} (${n.number})` : n.number}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div class="conversations-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {showNewConversation && this.renderNewConversationForm()}

        {conversations.length === 0 && !error && !showNewConversation && (
          <p class="conversations-empty">No conversations yet.</p>
        )}

        <ul class="conversations-list" aria-label="Conversations">
          {conversations.map((conv) => {
            const providerDisplay = this.getProviderNumberDisplay(conv.providerNumber);
            const providerColor = conv.providerNumber
              ? this.state.numberColors[conv.providerNumber] || "#6750A4"
              : null;
            const preview = truncatePreview(conv.lastMessagePreview, 50);
            const unread = isConversationUnread(conv);
            return (
              <li key={threadKey(conv.providerNumber, conv.phoneNumber)} class="conversation-item">
                <button
                  type="button"
                  class={`conversation-button${unread ? " conversation-unread" : ""}`}
                  onClick={() => this.handleSelectConversation(conv.phoneNumber, conv.providerNumber)}
                  aria-label={
                    `Open conversation with ${conv.phoneNumber}` +
                    (providerDisplay ? ` via ${providerDisplay}` : "") +
                    (unread ? " (unread)" : "")
                  }
                >
                  <ContactAvatar displayName={conv.phoneNumber} />

                  <span class="conversation-content">
                    {/* Row 1: name + provider label with colored dot */}
                    <span class="conversation-row-top">
                      <span class="conversation-name">{conv.phoneNumber}</span>
                      {providerDisplay && providerColor && (
                        <span class="conversation-provider-label">
                          <span class="conversation-provider-text">{providerDisplay}</span>
                          <span
                            class="conversation-provider-dot"
                            style={{ backgroundColor: providerColor }}
                            aria-hidden="true"
                          />
                        </span>
                      )}
                    </span>

                    {/* Row 2: last message preview */}
                    <span class="conversation-preview">
                      {preview || "No messages yet"}
                    </span>

                    {/* Row 3: timestamp + unread indicator */}
                    <span class="conversation-row-bottom">
                      <span class="conversation-time">
                        {formatTimestamp(conv.lastMessageTimestamp)}
                      </span>
                      {unread && (
                        <span class="conversation-unread-dot" aria-hidden="true" />
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  private renderNewConversationForm() {
    const {
      newNumber,
      newNumberError,
      sourceNumbers,
      selectedSource,
      sourceLoading,
    } = this.state;

    return (
      <div
        class="new-conversation-form"
        role="form"
        aria-label="Start new conversation"
      >
        <h2>New Conversation</h2>

        <div class="form-field">
          <label htmlFor="new-conv-number">Phone Number (E.164)</label>
          <input
            id="new-conv-number"
            type="tel"
            value={newNumber}
            onInput={this.handleNewNumberInput}
            placeholder="+1234567890"
            aria-invalid={newNumberError ? "true" : undefined}
            aria-describedby={newNumberError ? "new-number-error" : undefined}
            class="input-field"
          />
          {newNumberError && (
            <div id="new-number-error" class="field-error" role="alert">
              {newNumberError}
            </div>
          )}
        </div>

        <div class="form-field">
          <label htmlFor="new-conv-source">From Number</label>
          {sourceLoading ? (
            <p class="loading-text">Loading numbers...</p>
          ) : (
            <select
              id="new-conv-source"
              value={selectedSource}
              onChange={this.handleSourceChange}
              class="input-field"
              aria-label="Select source number"
            >
              {sourceNumbers.length === 0 && (
                <option value="">No numbers available</option>
              )}
              {sourceNumbers.map((n) => (
                <option key={n.number} value={n.number}>
                  {n.number}
                  {n.label ? ` (${n.label})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <div class="form-actions">
          <button
            type="button"
            class="btn btn-primary"
            onClick={this.handleStartConversation}
            disabled={!newNumber || !selectedSource}
          >
            Start Conversation
          </button>
          <button
            type="button"
            class="btn btn-cancel"
            onClick={this.handleCancelNew}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  private renderMessageThread() {
    const {
      selectedNumber,
      messages,
      messagesLoading,
      composeBody,
      sending,
      sendError,
    } = this.state;

    return (
      <div class="message-thread-container" role="main">
        <div class="thread-header">
          <button
            type="button"
            class="btn-icon thread-back"
            onClick={this.handleBackToList}
            aria-label="Back to conversations"
          >
            {backIcon(22)}
          </button>
          <div class="thread-title-group">
            <h2 class="thread-title">{selectedNumber}</h2>
            {(() => {
              // Resolve the thread's own provider number from state (set when the
              // thread was opened), not by peer-only lookup — two threads can
              // share a peer, so matching on phoneNumber alone can mislabel.
              const provider = this.state.selectedProviderNumber;
              const providerDisplay = this.getProviderNumberDisplay(provider);
              const providerColor = provider
                ? this.state.numberColors[provider] || "#6750A4"
                : null;
              return providerDisplay && providerColor ? (
                <span
                  class="number-badge"
                  style={{ color: providerColor, backgroundColor: `${providerColor}1F` }}
                >
                  {providerDisplay}
                </span>
              ) : null;
            })()}
          </div>
          <div class="thread-actions">
            {selectedNumber && isNumericNumber(selectedNumber) && isDialerAvailable() && (
              <button
                type="button"
                class="btn-icon thread-action"
                onClick={this.handleCallPeer}
                aria-label={`Call ${selectedNumber}`}
                title="Call"
              >
                {phoneIcon(20)}
              </button>
            )}
            <button
              type="button"
              class="btn-icon btn-icon-danger thread-action"
              onClick={this.handleDeleteClick}
              aria-label="Delete conversation"
              title="Delete conversation"
            >
              {trashIcon(20)}
            </button>
          </div>
        </div>

        {this.state.confirmDelete && (
          <div
            class="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm conversation removal"
            onClick={this.handleDeleteCancel}
          >
            <div class="modal-content card" onClick={(e) => e.stopPropagation()}>
              <h3>Delete Conversation</h3>
              <p>
                Delete this conversation with <strong>{selectedNumber}</strong>?
                It will be removed from your list.
              </p>
              <div class="modal-actions">
                <button
                  type="button"
                  class="btn-secondary"
                  onClick={this.handleDeleteCancel}
                  disabled={this.state.deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn-danger"
                  onClick={this.handleDeleteConfirm}
                  disabled={this.state.deleting}
                  aria-busy={this.state.deleting ? "true" : undefined}
                >
                  {this.state.deleting ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {messagesLoading ? (
          <p class="loading-text" aria-live="polite">
            Loading messages...
          </p>
        ) : (
          <div
            class="messages-list"
            role="log"
            aria-label={`Messages with ${selectedNumber}`}
            aria-live="polite"
            ref={(el) => {
              this.messagesListRef = el as HTMLDivElement | null;
            }}
          >
            {messages.length === 0 && (
              <p class="messages-empty">
                No messages yet. Send the first message below.
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                class={`message-bubble ${msg.direction === "SENT" ? "message-sent" : "message-received"}`}
              >
                <div class="message-body">{msg.body}</div>
                <div class="message-meta">
                  <span class="message-time">
                    {formatMessageTime(msg.timestamp)}
                  </span>
                  {msg.direction === "SENT" && (
                    <span
                      class={`message-status status-${msg.status.toLowerCase()}`}
                      title={getStatusLabel(msg.status)}
                      aria-label={`Status: ${getStatusLabel(msg.status)}`}
                    >
                      {getStatusIcon(msg.status)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div class="compose-area" role="form" aria-label="Compose message">
          {sendError && (
            <div class="send-error" role="alert" aria-live="assertive">
              {sendError}
            </div>
          )}
          <div class="compose-input-wrapper">
            <textarea
              class="compose-input"
              value={composeBody}
              onInput={this.handleComposeInput}
              onKeyDown={this.handleComposeKeyDown}
              placeholder={selectedNumber && !isNumericNumber(selectedNumber) ? "Cannot reply to this sender" : "Type a message..."}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={sending || (!!selectedNumber && !isNumericNumber(selectedNumber))}
              aria-label="Message text"
              rows={3}
            />
            <div class="compose-footer">
              <span
                class={`char-count ${composeBody.length >= MAX_MESSAGE_LENGTH ? "char-count-limit" : ""}`}
                aria-live="polite"
                aria-atomic="true"
              >
                {MAX_MESSAGE_LENGTH - composeBody.length} characters remaining
              </span>
              <button
                type="button"
                class="btn btn-send"
                onClick={this.handleSendMessage}
                disabled={
                  sending ||
                  composeBody.length === 0 ||
                  composeBody.length > MAX_MESSAGE_LENGTH ||
                  (!!selectedNumber && !isNumericNumber(selectedNumber))
                }
                aria-label="Send message"
                aria-busy={sending ? "true" : undefined}
              >
                {sending ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const { selectedNumber } = this.state;

    if (selectedNumber) {
      return this.renderMessageThread();
    }

    return this.renderConversationList();
  }
}
