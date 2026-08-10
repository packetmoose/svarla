import crypto from 'node:crypto';

/**
 * A short-lived, single-use ticket for WebSocket authentication.
 * Prevents session tokens from being exposed in query parameters.
 */
interface WsTicket {
  sessionToken: string;
  deviceId: string;
  createdAt: number;
}

/** Ticket lifetime in milliseconds (30 seconds). */
const TICKET_TTL_MS = 30_000;

/** Maximum number of tickets to prevent memory exhaustion. */
const MAX_TICKETS = 1000;

/**
 * WsTicketService manages short-lived, single-use tickets for WebSocket connections.
 *
 * Flow:
 * 1. Client calls POST /api/auth/ws-ticket with a valid session token
 * 2. Server returns a random ticket (valid for 30s, single use)
 * 3. Client connects to WebSocket with ?ticket=<ticket>
 * 4. Server validates and consumes the ticket, maps back to session
 *
 * This prevents the long-lived session token from appearing in
 * access logs, proxy logs, and browser history.
 */
export class WsTicketService {
  private readonly tickets = new Map<string, WsTicket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodically clean expired tickets
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Issue a new ticket for the given session.
   * Returns the ticket string that the client should use to connect.
   */
  issueTicket(sessionToken: string, deviceId: string): string {
    // Prevent memory exhaustion
    if (this.tickets.size >= MAX_TICKETS) {
      this.cleanup();
      if (this.tickets.size >= MAX_TICKETS) {
        throw new Error('Too many pending WebSocket tickets');
      }
    }

    const ticket = crypto.randomBytes(32).toString('hex');
    this.tickets.set(ticket, {
      sessionToken,
      deviceId,
      createdAt: Date.now(),
    });

    return ticket;
  }

  /**
   * Validate and consume a ticket. Returns the session info if valid.
   * The ticket is removed after use (single-use).
   * Returns null if the ticket is invalid or expired.
   */
  consumeTicket(ticket: string): { sessionToken: string; deviceId: string } | null {
    const entry = this.tickets.get(ticket);
    if (!entry) {
      return null;
    }

    // Remove immediately (single-use)
    this.tickets.delete(ticket);

    // Check expiry
    if (Date.now() - entry.createdAt > TICKET_TTL_MS) {
      return null;
    }

    return {
      sessionToken: entry.sessionToken,
      deviceId: entry.deviceId,
    };
  }

  /**
   * Remove all expired tickets.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (now - entry.createdAt > TICKET_TTL_MS) {
        this.tickets.delete(ticket);
      }
    }
  }

  /**
   * Stop the cleanup interval. Call on shutdown.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.tickets.clear();
  }
}
