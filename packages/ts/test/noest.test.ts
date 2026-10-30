import { describe, expect, it } from 'vitest';
import { createClient, mapNoestStatus, ShippingError } from '../src';
import { mockFetch } from './helpers';

const WILAYAS = { status: 200, body: [{ code: 16, nom: 'Alger', is_active: 1 }] };
const COMMUNES = { status: 200, body: [{ id: 571, nom: 'Bab Ezzouar', wilaya_id: 16, code_postal: '16018', is_active: 1 }] };
const INPUT = {
  recipientName: 'Test',
  phone: '0550123456',
  address: 'x',
  wilayaId: 16,
  communeName: 'Bab Ezzouar',
  productName: 'Mug',
  price: 1000,
};

describe('noest', () => {
  it('uses the public API host by default and accepts a baseUrl override', async () => {
    const mock = mockFetch([WILAYAS, WILAYAS]);
    await createClient('noest', { apiToken: 't', userGuid: 'g', fetch: mock.fetch }).getWilayas();
    await createClient('noest', { apiToken: 't', userGuid: 'g', baseUrl: 'https://proxy.test/api/public/', fetch: mock.fetch }).getWilayas();
    expect(mock.calls.map((c) => c.url.toString())).toEqual([
      'https://app.noest-dz.com/api/public/get/wilayas',
      'https://proxy.test/api/public/get/wilayas',
    ]);
  });

  it('sends the token as a Bearer header (a "Bearer " prefix in the value is stripped)', async () => {
    const mock = mockFetch([WILAYAS]);
    await createClient('noest', { apiToken: 'Bearer abc', userGuid: 'g', fetch: mock.fetch }).getWilayas();
    expect(mock.calls[0]!.headers.authorization).toBe('Bearer abc');
  });

  it.each([
    ['apiToken', { apiToken: ' ', userGuid: 'g' }],
    ['userGuid', { apiToken: 't', userGuid: '' }],
  ])('requires %s', (_, options) => {
    expect(() => createClient('noest', options as any)).toThrow(
      expect.objectContaining({ code: 'AUTH_FAILED', provider: 'noest' }),
    );
  });

  it('does not validate orders by default', async () => {
    const mock = mockFetch([COMMUNES, { status: 200, body: { success: true, tracking: 'NST-1' } }]);
    const parcel = await createClient('noest', { apiToken: 't', userGuid: 'g', fetch: mock.fetch }).createParcel(INPUT);
    expect(parcel.status).toBe('pending');
    expect(mock.remaining()).toBe(0);
    expect(mock.calls).toHaveLength(2);
  });

  it('reports the created tracking number when validation fails', async () => {
    const mock = mockFetch([
      COMMUNES,
      { status: 200, body: { success: true, tracking: 'NST-1' } },
      { status: 200, body: { success: false, message: 'Stock insuffisant' } },
    ]);
    const client = createClient('noest', { apiToken: 't', userGuid: 'g', autoValidate: true, fetch: mock.fetch });
    const err = await client.createParcel(INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(ShippingError);
    expect(err.message).toBe('NOEST order NST-1 was created but could not be validated: Stock insuffisant');
  });

  it('omits raw everywhere when includeRaw is false', async () => {
    const desks = { status: 200, body: { '16B': { code: '16B', name: 'Alger', commune: 'Bab Azzouar', phones: { '0': '0550000000' } } } };
    const mock = mockFetch([desks]);
    const result = await createClient('noest', { apiToken: 't', userGuid: 'g', includeRaw: false, fetch: mock.fetch }).getStopDesks({
      wilayaId: 16,
    });
    expect(result).toEqual([{ id: '16B', name: 'Alger', wilayaId: '16', phone: '0550000000' }]);
  });

  it('maps event keys and English labels, never French display labels', () => {
    expect(mapNoestStatus('livred')).toBe('delivered');
    expect(mapNoestStatus('Return_Asked_By_Hub')).toBe('returned');
    expect(mapNoestStatus('Out for delivery')).toBe('in_transit');
    expect(mapNoestStatus('Validé')).toBe('unknown');
    expect(mapNoestStatus(undefined)).toBe('unknown');
  });
});
