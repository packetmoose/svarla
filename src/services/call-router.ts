import type { DeviceInfo } from './device-registry-manager.js';
import type { TelephonyProvider, CallAnswerResult } from '../providers/telephony-provider.js';

/**
 * Information about an active call on a specific provider number.
 */
export interface ActiveCallInfo {
  callId: string;
  deviceId: string;
  remoteParty: string;
  startedAt: Date;
  providerNumber: string;
}

/**
 * State for an incoming call being routed across devices.
 */
export interface PendingIncomingCall {
  callId: string;
  from: string;
  to: string;
  startedAt: Date;
  /** Whether the call has been resolved (answered, declined, timed out, or caller disconnected) */
  resolved: boolean;
  /** Timer handle for the 30-second timeout */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

/**
 * Events broadcast to devices for call routing coordination.
 */
export type CallRouterEvent =
  | { type: 'incoming_call'; callId: string; from: string; providerNumber: string }
  | { type: 'call_answered'; callId: string; deviceId: string; providerNumber: string }
  | { type: 'call_cancelled'; callId: string; reason: 'answered_elsewhere' | 'declined' | 'timeout' | 'caller_disconnected' }
  | { type: 'stop_ringing'; callId: string }
  | { type: 'active_call_started'; providerNumber: string; info: ActiveCallInfo }
  | { type: 'active_call_ended'; providerNumber: string };

export type CallRouterBroadcast = (event: CallRouterEvent) => void;

export interface CallRouterDeps {
  provider: TelephonyProvider;
  getActiveDevices: () => Promise<DeviceInfo[]>;
  broadcast: CallRouterBroadcast;
  onMissedCall?: (callId: string, from: string, to: string) => void;
  onDeclinedCall?: (callId: string, from: string, to: string) => void;
}

/**
 * CallRouter coordinates inbound calls across multiple registered devices.
 *
 * Ring-all-devices strategy:
 * - On incoming call: notify all active devices
 * - First device to answer wins; all others are cancelled
 * - If declined on one device OR no answer in 30s: end call, notify all devices
 * - If caller disconnects: cancel ringing on all devices
 *
 * Race condition handling:
 * - Uses a resolved flag per callId to ensure only the first answerCall() succeeds
 * - Subsequent answer attempts are rejected
 *
 * Active call tracking:
 * - Maintains an in-memory Map<providerNumber, ActiveCallInfo> for cross-device "in-use" display
 */
export class CallRouter {
  private readonly provider: TelephonyProvider;
  private readonly broadcast: CallRouterBroadcast;
  private readonly onMissedCall?: (callId: string, from: string, to: string) => void;
  private readonly onDeclinedCall?: (callId: string, from: string, to: string) => void;

  /** Pending incoming calls being routed (callId → state) */
  private readonly pendingCalls = new Map<string, PendingIncomingCall>();

  /** Active calls keyed by provider number for in-use display */
  private readonly activeCalls = new Map<string, ActiveCallInfo>();

  /** Ring timeout duration in milliseconds */
  private readonly ringTimeoutMs: number;

  constructor(deps: CallRouterDeps, ringTimeoutMs = 30_000) {
    this.provider = deps.provider;
    this.broadcast = deps.broadcast;
    this.onMissedCall = deps.onMissedCall;
    this.onDeclinedCall = deps.onDeclinedCall;
    this.ringTimeoutMs = ringTimeoutMs;
  }

  /**
   * Handle an incoming call event. Notifies all active devices and starts the 30s timeout.
   */
  async handleIncomingCall(callId: string, from: string, to: string): Promise<void> {
    // If we already have a pending call with this ID, ignore the duplicate
    if (this.pendingCalls.has(callId)) {
      return;
    }

    const pendingCall: PendingIncomingCall = {
      callId,
      from,
      to,
      startedAt: new Date(),
      resolved: false,
      timeoutHandle: null,
    };

    this.pendingCalls.set(callId, pendingCall);

    // Notify all active devices about the incoming call
    this.broadcast({
      type: 'incoming_call',
      callId,
      from,
      providerNumber: to,
    });

    // Start 30-second timeout
    pendingCall.timeoutHandle = setTimeout(() => {
      this.handleTimeout(callId);
    }, this.ringTimeoutMs);
  }

  /**
   * Answer a call from a specific device.
   * Returns the answer result. If the call was already resolved (race condition),
   * returns a rejection.
   */
  async answerCall(callId: string, deviceId: string): Promise<CallAnswerResult> {
    const pendingCall = this.pendingCalls.get(callId);

    if (!pendingCall) {
      return {
        success: false,
        clientToken: null,
        errorReason: 'Call not found or already ended',
      };
    }

    // Race condition guard: only the first answer wins
    if (pendingCall.resolved) {
      return {
        success: false,
        clientToken: null,
        errorReason: 'Call already answered by another device',
      };
    }

    // Mark as resolved BEFORE the async call to prevent races
    pendingCall.resolved = true;

    // Clear the timeout
    if (pendingCall.timeoutHandle !== null) {
      clearTimeout(pendingCall.timeoutHandle);
      pendingCall.timeoutHandle = null;
    }

    // Attempt to answer via provider
    const result = await this.provider.answerCall(callId, deviceId);

    if (!result.success) {
      // Answer failed at provider level — unresolve so another device can try
      pendingCall.resolved = false;
      // Restart timeout
      pendingCall.timeoutHandle = setTimeout(() => {
        this.handleTimeout(callId);
      }, this.ringTimeoutMs);
      return result;
    }

    // Success: track as active call
    const activeCallInfo: ActiveCallInfo = {
      callId,
      deviceId,
      remoteParty: pendingCall.from,
      startedAt: new Date(),
      providerNumber: pendingCall.to,
    };

    this.activeCalls.set(pendingCall.to, activeCallInfo);

    // Broadcast answer to all devices (cancel ringing on others)
    this.broadcast({
      type: 'call_answered',
      callId,
      deviceId,
      providerNumber: pendingCall.to,
    });

    this.broadcast({
      type: 'call_cancelled',
      callId,
      reason: 'answered_elsewhere',
    });

    this.broadcast({
      type: 'active_call_started',
      providerNumber: pendingCall.to,
      info: activeCallInfo,
    });

    // Clean up pending call
    this.pendingCalls.delete(callId);

    return result;
  }

  /**
   * Decline a call from a specific device. Ends the call for all devices.
   */
  async declineCall(callId: string): Promise<void> {
    const pendingCall = this.pendingCalls.get(callId);

    if (!pendingCall || pendingCall.resolved) {
      return;
    }

    pendingCall.resolved = true;

    // Clear the timeout
    if (pendingCall.timeoutHandle !== null) {
      clearTimeout(pendingCall.timeoutHandle);
      pendingCall.timeoutHandle = null;
    }

    // End call via provider
    await this.provider.endCall(callId);

    // Notify all devices to stop ringing
    this.broadcast({
      type: 'stop_ringing',
      callId,
    });

    this.broadcast({
      type: 'call_cancelled',
      callId,
      reason: 'declined',
    });

    // Record as declined call (not missed — user explicitly rejected it)
    this.onDeclinedCall?.(callId, pendingCall.from, pendingCall.to);

    // Clean up
    this.pendingCalls.delete(callId);
  }

  /**
   * Handle caller disconnect before any device answers.
   */
  handleCallerDisconnect(callId: string): void {
    const pendingCall = this.pendingCalls.get(callId);

    if (!pendingCall || pendingCall.resolved) {
      return;
    }

    pendingCall.resolved = true;

    // Clear the timeout
    if (pendingCall.timeoutHandle !== null) {
      clearTimeout(pendingCall.timeoutHandle);
      pendingCall.timeoutHandle = null;
    }

    // Notify all devices to stop ringing
    this.broadcast({
      type: 'stop_ringing',
      callId,
    });

    this.broadcast({
      type: 'call_cancelled',
      callId,
      reason: 'caller_disconnected',
    });

    // Record as missed call
    this.onMissedCall?.(callId, pendingCall.from, pendingCall.to);

    // Clean up
    this.pendingCalls.delete(callId);
  }

  /**
   * Handle call ended (for active calls). Removes from active tracking.
   */
  handleCallEnded(callId: string): void {
    // Check if it's a pending call that ended (caller disconnect)
    if (this.pendingCalls.has(callId)) {
      this.handleCallerDisconnect(callId);
      return;
    }

    // Check active calls
    for (const [providerNumber, info] of this.activeCalls) {
      if (info.callId === callId) {
        this.activeCalls.delete(providerNumber);
        this.broadcast({
          type: 'active_call_ended',
          providerNumber,
        });
        return;
      }
    }
  }

  /**
   * Get active call info for a provider number (for cross-device "in-use" display).
   */
  getActiveCallForNumber(providerNumber: string): ActiveCallInfo | null {
    return this.activeCalls.get(providerNumber) ?? null;
  }

  /**
   * Get all active calls (for cross-device status display).
   */
  getAllActiveCalls(): Map<string, ActiveCallInfo> {
    return new Map(this.activeCalls);
  }

  /**
   * Check if a call is currently pending (ringing).
   */
  isPendingCall(callId: string): boolean {
    const pending = this.pendingCalls.get(callId);
    return pending !== undefined && !pending.resolved;
  }

  /**
   * Clean up all pending calls and timers. Call on shutdown.
   */
  dispose(): void {
    for (const pending of this.pendingCalls.values()) {
      if (pending.timeoutHandle !== null) {
        clearTimeout(pending.timeoutHandle);
        pending.timeoutHandle = null;
      }
    }
    this.pendingCalls.clear();
    this.activeCalls.clear();
  }

  /**
   * Internal: handle ring timeout (30s with no answer).
   */
  private handleTimeout(callId: string): void {
    const pendingCall = this.pendingCalls.get(callId);

    if (!pendingCall || pendingCall.resolved) {
      return;
    }

    pendingCall.resolved = true;
    pendingCall.timeoutHandle = null;

    // End call via provider (fire-and-forget, don't block timeout handler)
    this.provider.endCall(callId).catch(() => {
      // Best-effort: provider may have already ended the call
    });

    // Notify all devices to stop ringing
    this.broadcast({
      type: 'stop_ringing',
      callId,
    });

    this.broadcast({
      type: 'call_cancelled',
      callId,
      reason: 'timeout',
    });

    // Record as missed call
    this.onMissedCall?.(callId, pendingCall.from, pendingCall.to);

    // Clean up
    this.pendingCalls.delete(callId);
  }
}
