import { h, Component } from "preact";
import { api } from "../api";
import { initWebSocket, getWebSocket } from "../ws";

interface Conversation {
  phoneNumber: string;
  providerNumber: string | null;
  providerNumberColor: string | null;
  lastMessagePreview: string | null;
  lastMessageTimestamp: string | null;
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
  color: string;
}

interface ConversationsResponse {
  conversations: Conversation[];
}

interface MessagesResponse {
  messages: Message[];
}

interface NumbersResponse {
  numbers: NumberEntry[];
}

interface ConversationsState {
  conversations: Conversation[];
  loading: boolean;
  error: string;
  selectedNumber: string | null;
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
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
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
  };

  private unsubNewMessage: (() => void) | null = null;
  private unsubMessageStatus: (() => void) | null = null;
  private unsubConnected: (() => void) | null = null;

  componentDidMount() {
    this.fetchConversations();
    this.fetchNumberLabels();
    this.setupWebSocket();
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
  }

  private setupWebSocket() {
    const ws = getWebSocket() || initWebSocket();

    this.unsubNewMessage = ws.subscribe("new_message", (data: unknown) => {
      const msg = data as Message;
      const { selectedNumber, messages, conversations } = this.state;

      // Append message to thread if viewing that conversation
      if (selectedNumber && msg.conversation_number === selectedNumber) {
        this.setState({ messages: [...messages, msg] });
      }

      // Update conversation list preview
      const updatedConversations = conversations.map((c) => {
        if (c.phoneNumber === msg.conversation_number) {
          return {
            ...c,
            lastMessagePreview: msg.body,
            lastMessageTimestamp: msg.timestamp,
          };
        }
        return c;
      });

      // If conversation doesn't exist, add it
      const exists = updatedConversations.some(
        (c) => c.phoneNumber === msg.conversation_number
      );
      if (!exists) {
        updatedConversations.unshift({
          phoneNumber: msg.conversation_number,
          lastMessagePreview: msg.body,
          lastMessageTimestamp: msg.timestamp,
        });
      }

      // Re-sort by most recent
      updatedConversations.sort((a, b) => {
        const timeA = a.lastMessageTimestamp
          ? new Date(a.lastMessageTimestamp).getTime()
          : 0;
        const timeB = b.lastMessageTimestamp
          ? new Date(b.lastMessageTimestamp).getTime()
          : 0;
        return timeB - timeA;
      });

      this.setState({ conversations: updatedConversations });
    });

    this.unsubMessageStatus = ws.subscribe("message_status", (data: unknown) => {
      const update = data as { id: string; status: string };
      const { messages } = this.state;

      const updatedMessages = messages.map((m) => {
        if (m.id === update.id) {
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
        this.fetchMessages(this.state.selectedNumber);
      }
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

  private async fetchMessages(phoneNumber: string) {
    this.setState({
      selectedNumber: phoneNumber,
      messagesLoading: true,
      messages: [],
      composeBody: "",
      sendError: "",
    });

    // Fetch messages and source numbers in parallel
    const [messagesResult, numbersResult] = await Promise.all([
      api.get<MessagesResponse>(
        `/api/conversations/${encodeURIComponent(phoneNumber)}`
      ),
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

    // Load source numbers for sending
    if (numbersResult.ok) {
      const activeNumbers = numbersResult.data.numbers.filter((n) => n.isActive);
      this.setState({
        sourceNumbers: activeNumbers,
        selectedSource: activeNumbers.length > 0 ? activeNumbers[0].number : "",
      });
    }

    this.setState({ messages: sorted, messagesLoading: false });
  }

  private handleSelectConversation = (phoneNumber: string) => {
    this.fetchMessages(phoneNumber);
  };

  private handleBackToList = () => {
    this.setState({
      selectedNumber: null,
      messages: [],
      composeBody: "",
      sendError: "",
    });
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

    // Use the first source number as default or the selected source
    const from =
      this.state.selectedSource ||
      (sourceNumbers.length > 0 ? sourceNumbers[0].number : "");

    if (!from) {
      this.setState({ sendError: "No source number available" });
      return;
    }

    this.setState({ sending: true, sendError: "" });

    const result = await api.post<{ message: Message }>("/api/sms/send", {
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

    // Append sent message to thread
    if (result.data.message) {
      this.setState((prev) => ({
        messages: [...prev.messages, result.data.message],
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
            const providerColor = conv.providerNumber ? (this.state.numberColors[conv.providerNumber] || "#6750A4") : null;
            return (
              <li key={conv.phoneNumber} class="conversation-item">
                <button
                  type="button"
                  class="conversation-button"
                  onClick={() => this.handleSelectConversation(conv.phoneNumber)}
                  aria-label={`Open conversation with ${conv.phoneNumber}`}
                >
                  <span class="conversation-number-group">
                    <span class="conversation-number">{conv.phoneNumber}</span>
                    {providerDisplay && providerColor && (
                      <span
                        class="number-badge"
                        style={{ color: providerColor, backgroundColor: `${providerColor}1F` }}
                      >
                        {providerDisplay}
                      </span>
                    )}
                  </span>
                  <span class="conversation-preview">
                    {truncatePreview(conv.lastMessagePreview, 50)}
                  </span>
                  <span class="conversation-time">
                    {formatTimestamp(conv.lastMessageTimestamp)}
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
            class="btn btn-back"
            onClick={this.handleBackToList}
            aria-label="Back to conversations"
          >
            ← Back
          </button>
          <div class="thread-title-group">
            <h2 class="thread-title">{selectedNumber}</h2>
            {(() => {
              const conv = this.state.conversations.find(c => c.phoneNumber === selectedNumber);
              const providerDisplay = this.getProviderNumberDisplay(conv?.providerNumber ?? null);
              const providerColor = conv?.providerNumber ? (this.state.numberColors[conv.providerNumber] || "#6750A4") : null;
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
        </div>

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
