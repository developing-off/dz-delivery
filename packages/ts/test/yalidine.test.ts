import { describe, expect, it } from 'vitest';
import { createClient } from '../src';
import { yalidineDateToIso } from '../src/providers/yalidine';
import { mockFetch } from './helpers';

const wilayas = { has_more: false, data: [{ id: 16, name: 'Alger', is_deliverable: 1 }] };

describe('Yalidine', () => {
  it('requires fromWilaya for createParcel, before any HTTP call', async () => {
    const mock = mockFetch([]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    await expect(
      c.createParcel({
        recipientName: 'Test',
        phone: '0550123456',
        address: 'x',
        wilayaId: 16,
        communeId: 1601,
        productName: 'Mug',
        price: 100,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', provider: 'yalidine' });
    expect(mock.calls).toHaveLength(0);
  });

  it('follows has_more pagination', async () => {
    const mock = mockFetch([
      { status: 200, body: { has_more: true, data: [{ id: 1, name: 'Adrar', is_deliverable: 1 }] } },
      { status: 200, body: { has_more: false, data: [{ id: 2, name: 'Chlef', is_deliverable: 1 }] } },
    ]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    const list = await c.getWilayas();
    expect(list.map((w) => w.name)).toEqual(['Adrar', 'Chlef']);
    expect(mock.calls.map((r) => r.url.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('resolves wilaya names for getCommunes', async () => {
    const mock = mockFetch([
      { status: 200, body: wilayas },
      { status: 200, body: { has_more: false, data: [{ id: 1601, name: 'Alger Centre', wilaya_id: 16 }] } },
    ]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    const communes = await c.getCommunes('ALGER');
    expect(communes[0]).toMatchObject({ id: '1601', parentId: '16' });
    expect(mock.calls[1]!.url.searchParams.get('wilaya_id')).toBe('16');
  });

  it('healthCheck probes wilayas and returns latency', async () => {
    const mock = mockFetch([{ status: 200, body: wilayas }]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    const health = await c.healthCheck();
    expect(health).toMatchObject({ ok: true, provider: 'yalidine' });
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mock.calls).toHaveLength(1);
  });

  it('healthCheck bypasses the wilayas cache', async () => {
    const mock = mockFetch([
      { status: 200, body: wilayas },
      { status: 200, body: wilayas },
    ]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    await c.getWilayas();
    await c.healthCheck();
    expect(mock.calls).toHaveLength(2);
  });

  it('maps 429 to RATE_LIMITED', async () => {
    const mock = mockFetch([
      { status: 429, headers: { 'x-second-quota-left': '0' }, body: { error: { status_code: 429, message: 'Too many' } } },
    ]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    await expect(c.getWilayas()).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429, message: 'Too many' });
  });

  it('exposes Retry-After on RATE_LIMITED', async () => {
    const mock = mockFetch([{ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Too many' } } }]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    await expect(c.getWilayas()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 7 });
  });

  it('sends integer dimensions, 0 when missing', async () => {
    const mock = mockFetch([
      { status: 200, body: wilayas },
      { status: 200, body: { has_more: false, data: [{ id: 1601, name: 'Alger Centre', wilaya_id: 16 }] } },
      { status: 200, body: { O1: { success: true, order_id: 'O1', tracking: 'yal-1' } } },
    ]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fromWilayaId: 16, fetch: mock.fetch });
    await c.createParcel({
      recipientName: 'Test',
      phone: '0550123456',
      address: 'x',
      wilayaId: 16,
      communeId: 1601,
      productName: 'Mug',
      price: 100,
      weight: 1.2,
      length: 20,
      orderId: 'O1',
    });
    expect((mock.calls[2]!.body as Record<string, unknown>[])[0]).toMatchObject({ length: 20, width: 0, height: 0, weight: 2 });
  });

  it('reports a refused delete as VALIDATION_ERROR', async () => {
    const mock = mockFetch([{ status: 200, body: [{ tracking: 'yal-1', deleted: false }] }]);
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mock.fetch });
    await expect(c.cancelParcel('yal-1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('requires an origin wilaya for getFees', async () => {
    const c = createClient('yalidine', { apiId: 'i', apiToken: 't', fetch: mockFetch([]).fetch });
    await expect(c.getFees({ toWilayaId: 31 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('converts Yalidine local dates to ISO 8601 with offset', () => {
    expect(yalidineDateToIso('2025-12-30 13:24:34')).toBe('2025-12-30T13:24:34+01:00');
    expect(yalidineDateToIso('2025-12-30T13:24')).toBe('2025-12-30T13:24:00+01:00');
    expect(yalidineDateToIso('2025-12-30T13:24:34Z')).toBe('2025-12-30T13:24:34+00:00');
  });
});
