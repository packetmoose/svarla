/**
 * NCCO (Nexmo Call Control Object) builder utility.
 *
 * Constructs NCCO JSON arrays for Vonage Voice API call routing.
 * Used internally by VonageTelephonyProvider to generate webhook responses.
 */

export interface NccoPhoneEndpoint {
  type: 'phone';
  number: string;
}

export interface NccoSipEndpoint {
  type: 'sip';
  uri: string;
}

export type NccoEndpoint = NccoPhoneEndpoint | NccoSipEndpoint;

export interface NccoConnectAction {
  action: 'connect';
  endpoint: NccoEndpoint[];
  from?: string;
  eventUrl?: string[];
  timeout?: number;
}

export interface NccoTalkAction {
  action: 'talk';
  text: string;
  bargeIn?: boolean;
  loop?: number;
  language?: string;
}

export interface NccoStreamAction {
  action: 'stream';
  streamUrl: string[];
  bargeIn?: boolean;
  loop?: number;
}

export interface NccoConversationAction {
  action: 'conversation';
  name: string;
  startOnEnter?: boolean;
  endOnExit?: boolean;
  musicOnHoldUrl?: string[];
}

export type NccoAction = NccoConnectAction | NccoTalkAction | NccoStreamAction | NccoConversationAction;

/**
 * Builds NCCO for an outbound call connecting to a phone number.
 *
 * @param to - Destination phone number in E.164 format
 * @param from - Caller ID phone number in E.164 format
 * @param eventUrl - Optional event callback URL
 * @returns NCCO action array
 */
export function buildOutboundCallNcco(
  to: string,
  from: string,
  eventUrl?: string
): NccoAction[] {
  const action: NccoConnectAction = {
    action: 'connect',
    endpoint: [{ type: 'phone', number: to }],
    from,
  };

  if (eventUrl) {
    action.eventUrl = [eventUrl];
  }

  return [action];
}

/**
 * Builds NCCO connecting a call to a SIP endpoint (MediaBridge).
 *
 * Used for both outbound and inbound calls in the new server-relayed architecture:
 * - Outbound: Vonage connects the PSTN leg to the MediaBridge SIP endpoint
 * - Inbound: The caller is connected to the MediaBridge SIP endpoint
 *
 * @param sipUri - SIP URI of the MediaBridge session (e.g., "sip://session-id@mediabridge:5060")
 * @param from - Optional caller ID number in E.164 format
 * @param eventUrl - Optional event callback URL
 * @returns NCCO action array with a single SIP connect action
 */
export function buildSipConnectNcco(
  sipUri: string,
  from?: string,
  eventUrl?: string
): NccoAction[] {
  const action: NccoConnectAction = {
    action: 'connect',
    endpoint: [{ type: 'sip', uri: sipUri }],
  };

  if (from) {
    action.from = from;
  }

  if (eventUrl) {
    action.eventUrl = [eventUrl];
  }

  return [action];
}
