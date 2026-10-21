import { createHmac, timingSafeEqual } from 'node:crypto';
import { ShippingError } from '../errors';
import type { ParcelStatus } from '../types';
import { isRecord, str } from '../utils';
import { mapZRExpressStatus } from './zrexpress';

/** Default clock skew allowed for Standard Webhooks / Svix timestamps (seconds). */
export const ZREXPRESS_WEBHOOK_TOLERANCE_SEC = 5 * 60;

export interface ZRExpressWebhookEvent {
  /** Native event type, e.g. `parcel.state.updated`. */
  type: string;
  parcelId?: string;
  trackingNumber?: string;
  /** Merchant `externalId` when present. */
  orderId?: string;
  /** Unified status when the payload includes a mappable `state.name`. */
  status?: ParcelStatus;
  occurredAt?: string;
  /** Unmodified parsed JSON body. */
  raw: unknown;
}

export type ZRExpressWebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get?(name: string): string | null | undefined };

/**
 * Parses a ZRExpress webhook JSON body **without** verifying the signature.
 * Useful in unit tests or after you already verified the request yourself.
 */
export function parseZRExpressWebhook(payload: unknown): ZRExpressWebhookEvent {
  if (!isRecord(payload)) {
    throw new ShippingError('VALIDATION_ERROR', 'ZRExpress webhook payload must be a JSON object', {
      provider: 'zrexpress',
      raw: payload,
    });
  }

  const type = str(payload.eventType) ?? str(payload.type) ?? '';
  if (!type) {
    throw new ShippingError('VALIDATION_ERROR', 'ZRExpress webhook missing eventType', {
      provider: 'zrexpress',
      raw: payload,
    });
  }

  const data = isRecord(payload.data) ? payload.data : undefined;
  const state = data && isRecord(data.state) ? data.state : undefined;
  const stateName = state ? str(state.name) : undefined;

  const event: ZRExpressWebhookEvent = {
    type,
    raw: payload,
  };
  const parcelId = data ? str(data.id) : undefined;
  if (parcelId) event.parcelId = parcelId;
  const trackingNumber = data ? str(data.trackingNumber) : undefined;
  if (trackingNumber) event.trackingNumber = trackingNumber;
  const orderId = data ? str(data.externalId) : undefined;
  if (orderId) event.orderId = orderId;
  if (stateName) event.status = mapZRExpressStatus(stateName);
  const occurredAt = str(payload.occurredAt);
  if (occurredAt) event.occurredAt = occurredAt;
  return event;
}

/**
 * Verifies a Standard Webhooks / Svix signature, then parses the payload.
 *
 * Pass the **raw** request body (string or Buffer) — never a re-serialized JSON object.
 * Accepts `svix-*` headers and `webhook-*` aliases.
 */
export function verifyZRExpressWebhook(
  rawBody: string | Buffer,
  headers: ZRExpressWebhookHeaders,
  secret: string,
  options?: { toleranceSec?: number; now?: number },
): ZRExpressWebhookEvent {
  if (!secret?.trim()) {
    throw new ShippingError('AUTH_FAILED', 'ZRExpress webhook secret is required', { provider: 'zrexpress' });
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const msgId = header(headers, 'svix-id') ?? header(headers, 'webhook-id');
  const msgTimestamp = header(headers, 'svix-timestamp') ?? header(headers, 'webhook-timestamp');
  const msgSignature = header(headers, 'svix-signature') ?? header(headers, 'webhook-signature');

  if (!msgId || !msgTimestamp || !msgSignature) {
    throw new ShippingError(
      'AUTH_FAILED',
      'Missing Svix webhook headers (svix-id / svix-timestamp / svix-signature)',
      { provider: 'zrexpress' },
    );
  }

  const ts = Number(msgTimestamp);
  if (!Number.isFinite(ts)) {
    throw new ShippingError('VALIDATION_ERROR', 'Invalid webhook timestamp', { provider: 'zrexpress' });
  }

  const nowSec = Math.floor((options?.now ?? Date.now()) / 1000);
  const tolerance = options?.toleranceSec ?? ZREXPRESS_WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new ShippingError('AUTH_FAILED', 'Webhook timestamp outside allowed tolerance', {
      provider: 'zrexpress',
      details: [{ field: 'svix-timestamp', message: `skew > ${tolerance}s` }],
    });
  }

  const key = decodeWebhookSecret(secret);
  const toSign = `${msgId}.${msgTimestamp}.${body}`;
  const expected = createHmac('sha256', key).update(toSign, 'utf8').digest();
  const expectedB64 = expected.toString('base64');

  const candidates = msgSignature
    .split(' ')
    .map((part) => {
      const [, sig] = part.split(',', 2);
      return (sig ?? part).trim();
    })
    .filter(Boolean);

  const ok = candidates.some(
    (sig) => signaturesMatchB64(sig, expectedB64) || signaturesMatchHex(sig, expected),
  );
  if (!ok) {
    throw new ShippingError('AUTH_FAILED', 'Invalid ZRExpress webhook signature', { provider: 'zrexpress' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ShippingError('VALIDATION_ERROR', 'ZRExpress webhook body is not valid JSON', {
      provider: 'zrexpress',
      raw: body.slice(0, 200),
    });
  }

  return parseZRExpressWebhook(parsed);
}

function decodeWebhookSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.startsWith('whsec_')) {
    const b64 = trimmed.slice('whsec_'.length);
    return Buffer.from(b64, 'base64');
  }
  // Raw secret string (portal may show without prefix).
  return Buffer.from(trimmed, 'utf8');
}

function header(headers: ZRExpressWebhookHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const v = headers.get(name) ?? headers.get(lower);
    return v?.trim() || undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() !== lower) continue;
    const value = Array.isArray(v) ? v[0] : v;
    return value?.trim() || undefined;
  }
  return undefined;
}

function signaturesMatchB64(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'base64');
    const bb = Buffer.from(b, 'base64');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function signaturesMatchHex(a: string, expected: Buffer): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== expected.length * 2) return false;
  try {
    const ba = Buffer.from(a, 'hex');
    return ba.length === expected.length && timingSafeEqual(ba, expected);
  } catch {
    return false;
  }
}
