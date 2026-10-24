import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShippingError } from '../src';
import { parseZRExpressWebhook, verifyZRExpressWebhook } from '../src/providers/zrexpress-webhooks';
import { FIXTURES_DIR } from './helpers';

const fixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'zrexpress/webhooks/parcel-state-updated.json'), 'utf8'),
) as {
  /** Base64 key only: the `whsec_` prefix is added below so secret scanners don't flag the fixture. */
  secretKeyBase64: string;
  msgId: string;
  msgTimestamp: string;
  signature: string;
  rawBody: string;
  body: Record<string, unknown>;
  expected: Record<string, string>;
};

const secret = `whsec_${fixture.secretKeyBase64}`;
const rawBody = fixture.rawBody;
const headers = {
  'svix-id': fixture.msgId,
  'svix-timestamp': fixture.msgTimestamp,
  'svix-signature': fixture.signature,
};
const fixedNow = Number(fixture.msgTimestamp) * 1000;

describe('parseZRExpressWebhook', () => {
  it('maps parcel.state.updated to a unified event', () => {
    const event = parseZRExpressWebhook(fixture.body);
    expect(event).toMatchObject(fixture.expected);
    expect(event.raw).toEqual(fixture.body);
  });

  it('rejects non-objects', () => {
    expect(() => parseZRExpressWebhook(null)).toThrow(ShippingError);
  });
});

describe('verifyZRExpressWebhook', () => {
  it('accepts a valid Svix signature', () => {
    const event = verifyZRExpressWebhook(rawBody, headers, secret, { now: fixedNow });
    expect(event).toMatchObject(fixture.expected);
  });

  it('accepts webhook-* header aliases', () => {
    const event = verifyZRExpressWebhook(
      rawBody,
      {
        'webhook-id': fixture.msgId,
        'webhook-timestamp': fixture.msgTimestamp,
        'webhook-signature': fixture.signature,
      },
      secret,
      { now: fixedNow },
    );
    expect(event.type).toBe('parcel.state.updated');
  });

  it('rejects a bad signature', () => {
    try {
      verifyZRExpressWebhook(
        rawBody,
        { ...headers, 'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        secret,
        { now: fixedNow },
      );
      expect.unreachable('expected AUTH_FAILED');
    } catch (err) {
      expect(err).toMatchObject({ code: 'AUTH_FAILED' });
    }
  });

  it('rejects timestamp skew beyond tolerance', () => {
    try {
      verifyZRExpressWebhook(rawBody, headers, secret, {
        now: fixedNow + 10 * 60 * 1000,
        toleranceSec: 300,
      });
      expect.unreachable('expected AUTH_FAILED');
    } catch (err) {
      expect(err).toMatchObject({ code: 'AUTH_FAILED' });
    }
  });

  it('rejects missing headers', () => {
    try {
      verifyZRExpressWebhook(rawBody, {}, secret, { now: fixedNow });
      expect.unreachable('expected AUTH_FAILED');
    } catch (err) {
      expect(err).toMatchObject({ code: 'AUTH_FAILED' });
    }
  });
});
