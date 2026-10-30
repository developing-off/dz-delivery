import { describe, expect, it } from 'vitest';
import { createClient, mapNoestStatus, ShippingError } from '../src';
import { findLocationLoosely, looseNameKey } from '../src/utils';
import { mockFetch, readJson } from './helpers';

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

  it('rejects a non-https baseUrl (the token would travel in clear text)', () => {
    expect(() => createClient('noest', { apiToken: 't', userGuid: 'g', baseUrl: 'http://proxy.test' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', provider: 'noest' }),
    );
    expect(() => createClient('ecom', { apiKey: 'k', apiToken: 't', baseUrl: 'http://ecom.test/api_v2' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', provider: 'ecom' }),
    );
  });

  it('rejects an orderId shorter than 5 characters before any request', async () => {
    const mock = mockFetch([]);
    const err = await createClient('noest', { apiToken: 't', userGuid: 'g', fetch: mock.fetch })
      .createParcel({ ...INPUT, orderId: 'A12' })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'orderId' }] });
    expect(mock.calls).toHaveLength(0);
  });

  it('keeps business codes when a cancellation is refused', async () => {
    const mock = mockFetch([{ status: 200, body: { success: false, errors: { account_suspended: 'Compte suspendu' } } }]);
    const err = await createClient('noest', { apiToken: 't', userGuid: 'g', fetch: mock.fetch })
      .cancelParcel('NST-1')
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'AUTH_FAILED', details: [{ code: 'account_suspended' }] });
  });

  it('maps event keys and English labels, never French display labels', () => {
    expect(mapNoestStatus('livred')).toBe('delivered');
    expect(mapNoestStatus('Return_Asked_By_Hub')).toBe('returned');
    expect(mapNoestStatus('Out for delivery')).toBe('in_transit');
    expect(mapNoestStatus('Validé')).toBe('unknown');
    expect(mapNoestStatus(undefined)).toBe('unknown');
  });
});

describe('looseNameKey', () => {
  it('matches docs/fixtures/loose-names.json (shared with PHP Text::looseKey)', () => {
    for (const [name, key] of Object.entries(readJson<Record<string, string>>('loose-names.json'))) {
      expect(looseNameKey(name), name).toBe(key);
    }
  });

  it('only returns an unambiguous match with a meaningful key', () => {
    const communes = [
      { id: '1', name: 'Bab Azzouar' },
      { id: '2', name: 'Draria' },
      { id: '3', name: 'Ain Taya' },
      { id: '4', name: 'Hussein Dey' },
      { id: '5', name: 'Husein Dey' },
    ];
    expect(findLocationLoosely(communes, 'Bab Ezzouar')?.id).toBe('1');
    expect(findLocationLoosely(communes, 'Dreria')).toBeUndefined(); // key "dr" too short
    expect(findLocationLoosely(communes, 'Hussein-Dey')).toBeUndefined(); // two candidates
    expect(findLocationLoosely(communes, 'Atlantis')).toBeUndefined();
  });
});
