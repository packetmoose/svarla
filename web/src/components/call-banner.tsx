import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import { initWebSocket } from "../ws";
import { api } from "../api";

interface CallInfo {
  callId: string;
  from?: string;
}

interface ActiveCallResponse {
  calls: Array<{ callId: string; status: string; from?: string }>;
}

/**
 * Banner displayed at the top of the app when a call is in progress.
 * Fetches active calls on mount (for late-joining clients) and
 * subscribes to WebSocket call events for real-time updates.
 */
export function CallBanner() {
  const [activeCall, setActiveCall] = useState<CallInfo | null>(null);

  useEffect(() => {
    // Fetch current active calls (handles opening app mid-call)
    function fetchActiveCalls() {
      api.get<ActiveCallResponse>("/api/calls/active").then((res) => {
        if (res.ok && res.data.calls.length > 0) {
          const call = res.data.calls.find((c) => c.status === "connected");
          if (call) {
            setActiveCall({ callId: call.callId, from: call.from });
          } else {
            setActiveCall(null);
          }
        }
      });
    }

    fetchActiveCalls();

    const ws = initWebSocket();

    // Re-fetch active calls on WebSocket reconnect
    const unsubConnected = ws.subscribe("ws_connected", () => {
      fetchActiveCalls();
    });

    // Listen for call state changes
    const unsubCallEvent = ws.subscribe(
      "call_event",
      (data: unknown) => {
        const event = data as {
          callId?: string;
          status?: string;
          from?: string;
        };
        if (!event.callId) return;

        switch (event.status) {
          case "connected":
            setActiveCall({ callId: event.callId, from: event.from });
            break;
          case "completed":
          case "failed":
          case "busy":
            setActiveCall((current) =>
              current?.callId === event.callId ? null : current
            );
            break;
        }
      }
    );

    // Listen for call cancellations (answered elsewhere also means call in progress)
    const unsubCancelled = ws.subscribe(
      "call_cancelled",
      (data: unknown) => {
        const event = data as {
          callId?: string;
          reason?: string;
        };
        if (!event.callId) return;

        if (event.reason === "answered_elsewhere") {
          // Another device answered — show call in progress
          setActiveCall({ callId: event.callId });
        } else {
          // Call cancelled for other reasons — clear if it matches
          setActiveCall((current) =>
            current?.callId === event.callId ? null : current
          );
        }
      }
    );

    return () => {
      unsubConnected();
      unsubCallEvent();
      unsubCancelled();
    };
  }, []);

  if (!activeCall) {
    return null;
  }

  return (
    <div class="call-banner" role="status" aria-live="polite">
      <span class="call-banner-icon">📞</span>
      <span class="call-banner-text">
        Call in progress{activeCall.from ? ` — ${activeCall.from}` : ""}
      </span>
    </div>
  );
}
