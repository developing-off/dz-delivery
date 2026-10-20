import { describe, expect, it } from 'vitest';
import { createClient, normalizeAlgerianPhone, normalizeStatusKey, ShippingError } from '../src';
import { findLocationByName, sortEventsAscending, toIsoDate } from '../src/utils';

describe('createClient', () => {
  it('returns providers with the expected name', () => {
    expect(createClient('zrexpress', { apiKey: 'k', tenant: 't' }).name).toBe('zrexpress');
    expect(createClient('yalidine', { apiId: 'i', apiToken: 't' }).name).toBe('yalidine');
    expect(createClient('maystro', { apiToken: 't' }).name).toBe('maystro');
  });

  it('throws NOT_SUPPORTED for unknown providers', () => {
    const err = (() => {
      try {
        createClient('no-such-carrier' as any, {} as any);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ShippingError);
    expect(err).toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('normalizeAlgerianPhone', () => {
  it.each([
    ['0550123456', '+213550123456', '0550123456'],
    ['0550 12 34 56', '+213550123456', '0550123456'],
    ['+213 550-12-34-56', '+213550123456', '0550123456'],
    ['00213550123456', '+213550123456', '0550123456'],
    ['213550123456', '+213550123456', '0550123456'],
    ['550123456', '+213550123456', '0550123456'],
    ['021234567', '+21321234567', '021234567'],
  ])('%s', (input, intl, local) => {
    expect(normalizeAlgerianPhone(input, 'international')).toBe(intl);
    expect(normalizeAlgerianPhone(input, 'local')).toBe(local);
  });

  it.each(['12', '+33 6 12 34 56 78', 'abc'])('rejects %s with VALIDATION_ERROR', (input) => {
    expect(() => normalizeAlgerianPhone(input, 'international')).toThrow(/Invalid Algerian phone number/);
  });
});

describe('helpers', () => {
  it('normalizes status keys across naming styles', () => {
    expect(normalizeStatusKey('OutForDelivery')).toBe('outfordelivery');
    expect(normalizeStatusKey('out_for_delivery')).toBe('outfordelivery');
    expect(normalizeStatusKey('Prêt à expédier')).toBe('pretaexpedier');
  });

  it('converts native dates to ISO 8601 with offset', () => {
    expect(toIsoDate('2025-11-22T09:00:00Z')).toBe('2025-11-22T09:00:00+00:00');
    expect(toIsoDate('2025-12-23T15:23:54.2173951+00:00')).toBe('2025-12-23T15:23:54+00:00');
    expect(toIsoDate('2025-12-30 13:24:34', '+01:00')).toBe('2025-12-30T13:24:34+01:00');
    expect(toIsoDate('2025-12-30T13:24+0100')).toBe('2025-12-30T13:24:00+01:00');
    expect(toIsoDate('yesterday')).toBe('yesterday');
  });

  it('matches location names ignoring case, accents and separators', () => {
    const locs = [
      { id: '1', name: 'Béjaïa' },
      { id: '2', name: "Sidi M'Hamed" },
    ];
    expect(findLocationByName(locs, 'BEJAIA')?.id).toBe('1');
    expect(findLocationByName(locs, 'sidi mhamed')?.id).toBe('2');
    expect(findLocationByName(locs, 'Oran')).toBeUndefined();
  });

  it('sorts events oldest first', () => {
    const sorted = sortEventsAscending([
      { status: 'in_transit', label: 'b', at: '2025-01-02T00:00:00+01:00' },
      { status: 'pending', label: 'a', at: '2025-01-01T00:00:00+01:00' },
    ]);
    expect(sorted.map((e) => e.label)).toEqual(['a', 'b']);
  });
});
