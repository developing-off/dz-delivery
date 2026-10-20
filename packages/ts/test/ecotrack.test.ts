import { describe, expect, it } from 'vitest';
import { createClient, mapEcotrackStatus, resolveEcotrackBaseUrl, ShippingError } from '../src';
import { mockFetch } from './helpers';

const WILAYAS = { status: 200, body: [{ wilaya_id: 16, wilaya_name: 'Alger' }] };
const COMMUNES = {
  status: 200,
  body: {
    '0': { nom: 'Bab Ezzouar', wilaya_id: 16, code_postal: '1625', has_stop_desk: 1 },
    '1': { nom: 'Bordj El Kiffan', wilaya_id: 16, code_postal: '1617', has_stop_desk: 0 },
  },
};
const INPUT = {
  recipientName: 'Test',
  phone: '0550123456',
  address: 'x',
  wilayaId: 16,
  communeName: 'Bab Ezzouar',
  productName: 'Mug',
  price: 1000,
};

describe('ecotrack', () => {
  describe('tenant resolution', () => {
    it('resolves built-in courier keys (case-insensitive)', async () => {
      const mock = mockFetch([WILAYAS]);
      await createClient('ecotrack', { token: 't', courier: 'DHD', fetch: mock.fetch }).getWilayas();
      expect(mock.calls[0]!.url.toString()).toBe('https://platform.dhd-dz.com/api/v1/get/wilayas');
      expect(resolveEcotrackBaseUrl({ courier: 'conexlog' })).toBe('https://app.conexlog-dz.com');
    });

    it('appends /api/v1 to baseUrl and does not double it', async () => {
      const mock = mockFetch([WILAYAS, WILAYAS]);
      await createClient('ecotrack', { token: 't', baseUrl: 'https://test.ecotrack.dz/', fetch: mock.fetch }).getWilayas();
      await createClient('ecotrack', { token: 't', baseUrl: 'https://test.ecotrack.dz/api/v1/', fetch: mock.fetch }).getWilayas();
      expect(mock.calls.map((c) => c.url.toString())).toEqual([
        'https://test.ecotrack.dz/api/v1/get/wilayas',
        'https://test.ecotrack.dz/api/v1/get/wilayas',
      ]);
    });

    it.each([
      ['neither baseUrl nor courier', {}],
      ['both baseUrl and courier', { baseUrl: 'https://test.ecotrack.dz', courier: 'dhd' }],
      ['an unknown courier', { courier: 'nope' }],
      ['an http baseUrl', { baseUrl: 'http://test.ecotrack.dz' }],
      ['a malformed baseUrl', { baseUrl: 'test.ecotrack.dz' }],
    ])('rejects %s with VALIDATION_ERROR', (_, options) => {
      expect(() => createClient('ecotrack', { token: 't', ...options })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', provider: 'ecotrack' }),
      );
    });

    it('requires a token', () => {
      expect(() => createClient('ecotrack', { token: ' ', courier: 'dhd' })).toThrow(
        expect.objectContaining({ code: 'AUTH_FAILED' }),
      );
    });

    it('does not double the Bearer prefix', async () => {
      const mock = mockFetch([WILAYAS]);
      await createClient('ecotrack', { token: 'Bearer abc', courier: 'dhd', fetch: mock.fetch }).getWilayas();
      expect(mock.calls[0]!.headers.authorization).toBe('Bearer abc');
    });
  });

  it('maps stable keys only, never French labels', () => {
    expect(mapEcotrackStatus('Return_received')).toBe('returned');
    expect(mapEcotrackStatus('annule')).toBe('cancelled');
    expect(mapEcotrackStatus('Prêt à expédier')).toBe('unknown');
    expect(mapEcotrackStatus(null)).toBe('unknown');
  });

  it('reports a failed validation with the created tracking number', async () => {
    const mock = mockFetch([
      COMMUNES,
      { status: 200, body: { success: true, tracking: 'ECTEST1' } },
      { status: 429, headers: { 'Retry-After': '30' }, body: { message: 'Too Many Attempts.' } },
    ]);
    const client = createClient('ecotrack', { token: 't', courier: 'dhd', autoValidate: true, fetch: mock.fetch });
    const err = await client.createParcel(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(ShippingError);
    expect(err).toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      retryAfter: 30,
      message: 'Ecotrack order ECTEST1 was created but could not be validated: Too Many Attempts.',
    });
  });

  it('does not validate by default', async () => {
    const mock = mockFetch([COMMUNES, { status: 200, body: { success: true, tracking: 'ECTEST1' } }]);
    const parcel = await createClient('ecotrack', { token: 't', courier: 'dhd', fetch: mock.fetch }).createParcel(INPUT);
    expect(parcel.status).toBe('pending');
    expect(mock.remaining()).toBe(0);
    expect(mock.calls).toHaveLength(2);
  });

  it('lists stop desks from communes flagged has_stop_desk', async () => {
    const mock = mockFetch([WILAYAS, COMMUNES]);
    const client = createClient('ecotrack', { token: 't', courier: 'dhd', includeRaw: false, fetch: mock.fetch });
    expect(await client.getStopDesks({ wilayaId: 'Alger' })).toEqual([
      { id: '1625', name: 'Bab Ezzouar', communeId: '1625', wilayaId: '16' },
    ]);
  });
});
