/**
 * WebSocket client for real-time updates.
 * Connects to the server's WebSocket endpoint, handles reconnection,
 * and dispatches events to subscribers.
 */

type EventHandler = (data: unknown) => void;

interface WebSocketClient {
  subscribe(event: string, handler: EventHandler): () => void;
  send(event: string, data: unknown): void;
  close(): void;
}

let wsInstance: WebSocketClient | null = null;

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function initWebSocket(): WebSocketClient {
  if (wsInstance) {
    return wsInstance;
  }

  const subscribers = new Map<string, Set<EventHandler>>();
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function getWsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem("session_token") ?? "";
    return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function connect() {
    if (closed) return;

    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      reconnectDelay = RECONNECT_DELAY_MS;
      // Notify subscribers that the connection is (re)established
      // so they can re-fetch any state that may have been missed.
      const handlers = subscribers.get("ws_connected");
      if (handlers) {
        for (const handler of handlers) {
          handler(null);
        }
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type?: string;
          event?: string;
          data: unknown;
        };
        const eventName = msg.type ?? msg.event;
        if (!eventName) return;
        const handlers = subscribers.get(eventName);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.data);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (closed) return;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      connect();
    }, reconnectDelay);
  }

  function subscribe(event: string, handler: EventHandler): () => void {
    if (!subscribers.has(event)) {
      subscribers.set(event, new Set());
    }
    subscribers.get(event)!.add(handler);

    return () => {
      const handlers = subscribers.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          subscribers.delete(event);
        }
      }
    };
  }

  function send(event: string, data: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    wsInstance = null;
  }

  connect();

  wsInstance = { subscribe, send, close };
  return wsInstance;
}

export function getWebSocket(): WebSocketClient | null {
  return wsInstance;
}
