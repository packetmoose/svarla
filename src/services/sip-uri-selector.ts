/**
 * Input for selecting the appropriate SIP URI for the NCCO connect action.
 */
export interface SipUriSelectionInput {
  sipUri: string;
  sipsUri: string;
  supportsSips: boolean; // from provider config
  sipTlsEnabled: boolean; // from server config (sip.tls)
}

/**
 * Selects the appropriate SIP URI for the NCCO connect action.
 *
 * Decision rule:
 *   if provider supports sips AND sip.tls is enabled → use sipsUri
 *   otherwise → use sipUri
 */
export function selectSipUri(input: SipUriSelectionInput): string {
  if (input.supportsSips && input.sipTlsEnabled) {
    return input.sipsUri;
  }
  return input.sipUri;
}
