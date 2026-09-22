import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { verifyVonageWebhookJwt } from './webhook-auth-middleware.js';

/**
 * Security regression tests for Vonage webhook verification.
 *
 * The core requirement: authenticity is established ONLY by a valid HS256
 * signature made with the provider's signature secret. The public
 * `application_id` claim must never be accepted as a substitute, because a
 * forged (unsigned or wrongly-signed) token could carry the correct value.
 */
describe('verifyVonageWebhookJwt', () => {
  const SECRET = 'super-secret-signing-key';
  const APP_ID = '00000000-0000-0000-0000-000000000000';

  function makeRequest(authHeader?: string): FastifyRequest {
    return {
      headers: authHeader ? { authorization: authHeader } : {},
    } as unknown as FastifyRequest;
  }

  it('accepts a token correctly signed with the API secret', () => {
    const token = jwt.sign({ application_id: APP_ID }, SECRET, { algorithm: 'HS256' });
    const req = makeRequest(`Bearer ${token}`);

    expect(
      verifyVonageWebhookJwt(req, { vonageApiSecret: SECRET, vonageApplicationId: APP_ID }),
    ).toBe(true);
  });

  it('rejects a forged token that carries the correct application_id but a bad signature', () => {
    // Attacker knows the (public) application_id and signs with the wrong key.
    const forged = jwt.sign({ application_id: APP_ID }, 'attacker-guessed-key', {
      algorithm: 'HS256',
    });
    const req = makeRequest(`Bearer ${forged}`);

    expect(
      verifyVonageWebhookJwt(req, { vonageApiSecret: SECRET, vonageApplicationId: APP_ID }),
    ).toBe(false);
  });

  it('rejects an unsigned (alg=none) token even with a matching application_id', () => {
    // Build an alg=none token by hand: header.payload with empty signature.
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ application_id: APP_ID })}.`;
    const req = makeRequest(`Bearer ${noneToken}`);

    expect(
      verifyVonageWebhookJwt(req, { vonageApiSecret: SECRET, vonageApplicationId: APP_ID }),
    ).toBe(false);
  });

  it('fails closed when no signature secret is configured', () => {
    const token = jwt.sign({ application_id: APP_ID }, SECRET, { algorithm: 'HS256' });
    const req = makeRequest(`Bearer ${token}`);

    // Only application_id is known — cannot verify authenticity, so reject.
    expect(
      verifyVonageWebhookJwt(req, { vonageApplicationId: APP_ID }),
    ).toBe(false);
  });

  it('rejects a validly-signed token whose application_id does not match', () => {
    const token = jwt.sign({ application_id: 'some-other-app' }, SECRET, {
      algorithm: 'HS256',
    });
    const req = makeRequest(`Bearer ${token}`);

    expect(
      verifyVonageWebhookJwt(req, { vonageApiSecret: SECRET, vonageApplicationId: APP_ID }),
    ).toBe(false);
  });

  it('accepts a validly-signed token when no application_id guard is configured', () => {
    const token = jwt.sign({ application_id: APP_ID }, SECRET, { algorithm: 'HS256' });
    const req = makeRequest(`Bearer ${token}`);

    expect(verifyVonageWebhookJwt(req, { vonageApiSecret: SECRET })).toBe(true);
  });

  it('rejects when the Authorization header is missing or not a Bearer token', () => {
    expect(
      verifyVonageWebhookJwt(makeRequest(), { vonageApiSecret: SECRET }),
    ).toBe(false);
    expect(
      verifyVonageWebhookJwt(makeRequest('Basic abc123'), { vonageApiSecret: SECRET }),
    ).toBe(false);
  });
});
