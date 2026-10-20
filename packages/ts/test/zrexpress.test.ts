import { describe, expect, it } from 'vitest';
import { createClient, ShippingError } from '../src';
import { mockFetch } from './helpers';

const WILAYA = '11111111-1111-4111-8111-000000000016';
const COMMUNE = '22222222-2222-4222-8222-000000016001';
const PARCEL = '8c1a4c53-0000-4000-8000-000000000001';

function client(responses: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const mock = mockFetch(responses);
  const c = createClient('zrexpress', { apiKey: 'k', tenant: 't', fetch: mock.fetch, ...extra });
  return { c, mock };
}

const baseInput = {
  recipientName: 'Test Client',
  phone: '0550123456',
  address: '1 Rue de Test',
  wilayaId: WILAYA,
  communeId: COMMUNE,
  productName: 'T-shirt',
  price: 2500,
};

describe('ZRExpress createParcel', () => {
  it('maps ParcelInput to the native body and follows up with a GET', async () => {
    const { c, mock } = client([
      { status: 201, body: { id: PARCEL } },
      { status: 200, body: { id: PARCEL, trackingNumber: 'DZ-1', state: { name: 'OrderReceived' } } },
    ]);
    const parcel = await c.createParcel({ ...baseInput, remark: 'fragile', isStopDesk: false });

    expect(parcel).toMatchObject({ id: PARCEL, trackingNumber: 'DZ-1', status: 'pending', provider: 'zrexpress' });
    expect(parcel.raw).toMatchObject({ id: PARCEL });

    const body = mock.calls[0]!.body as Record<string, any>;
    expect(body.customer.customerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.customer.phone).toEqual({ number1: '+213550123456' });
    expect(body.description).toBe('T-shirt - fragile');
    expect(body.deliveryType).toBe('home');
    expect(body).not.toHaveProperty('hubId');
    expect(body).not.toHaveProperty('externalId');
    expect(body).not.toHaveProperty('weight');
    expect(mock.calls[0]!.headers['x-api-key']).toBe('k');
    expect(mock.calls[0]!.headers['x-tenant']).toBe('t');
  });

  it('rejects amount above the ZRExpress ceiling before any HTTP call', async () => {
    const { c, mock } = client([]);
    await expect(c.createParcel({ ...baseInput, price: 150_001 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'price' }],
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('validates input before any HTTP call', async () => {
    const { c, mock } = client([]);
    await expect(c.createParcel({ ...baseInput, isStopDesk: true })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'stopDeskId', message: 'stopDeskId is required when isStopDesk is true' }],
    });
    await expect(c.createParcel({ ...baseInput, productList: [{ name: 'x', quantity: 1 }] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('throws NOT_FOUND when the wilaya name cannot be resolved', async () => {
    const { c } = client([{ status: 200, body: { items: [{ id: WILAYA, code: 16, name: 'Alger', level: 'wilaya' }] } }]);
    const { wilayaId, ...rest } = baseInput;
    await expect(c.createParcel({ ...rest, wilayaName: 'Atlantis' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws PROVIDER_ERROR when the create response has no id', async () => {
    const { c } = client([{ status: 201, body: {} }]);
    await expect(c.createParcel(baseInput)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', httpStatus: 201 });
  });
});

describe('ZRExpress track', () => {
  it('returns unknown (never throws) on unmapped states and omits raw when includeRaw is false', async () => {
    const { c } = client(
      [
        { status: 200, body: { id: PARCEL, trackingNumber: 'DZ-1', state: { name: 'BrandNewState' } } },
        { status: 200, body: [{ createdAt: '2025-01-01T00:00:00Z', newState: { name: 'BrandNewState' } }] },
      ],
      { includeRaw: false },
    );
    const res = await c.track('DZ-1');
    expect(res.parcel.status).toBe('unknown');
    expect(res.parcel).not.toHaveProperty('raw');
    expect(res.events).toEqual([{ status: 'unknown', label: 'BrandNewState', at: '2025-01-01T00:00:00+00:00' }]);
  });
});

describe('ZRExpress errors', () => {
  it.each([
    [400, 'VALIDATION_ERROR'],
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [409, 'UNKNOWN'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
    [503, 'PROVIDER_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { c } = client([{ status, body: { title: 'Some.Title', status } }]);
    const err = await c.getWilayas().catch((e) => e);
    expect(err).toBeInstanceOf(ShippingError);
    expect(err).toMatchObject({ code, httpStatus: status, message: 'Some.Title', provider: 'zrexpress' });
    expect(err.raw).toEqual({ title: 'Some.Title', status });
  });

  it('maps ASP.NET-style validation dictionaries to details', async () => {
    const { c } = client([
      { status: 400, body: { title: 'Bad', errors: { 'Customer.Name': ['Too short'], Amount: ['Too big'] } } },
    ]);
    await expect(c.getWilayas()).rejects.toMatchObject({
      details: [
        { field: 'Customer.Name', message: 'Too short' },
        { field: 'Amount', message: 'Too big' },
      ],
    });
  });

  it('maps fetch failures to NETWORK_ERROR', async () => {
    const c = createClient('zrexpress', {
      apiKey: 'k',
      tenant: 't',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(c.getWilayas()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Network error: fetch failed' });
  });

  it('maps timeouts to NETWORK_ERROR', async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const c = createClient('zrexpress', { apiKey: 'k', tenant: 't', fetch: hanging, timeoutMs: 10 });
    await expect(c.getWilayas()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Request timed out after 10 ms' });
  });

  it('maps non-JSON success bodies to PROVIDER_ERROR', async () => {
    const c = createClient('zrexpress', {
      apiKey: 'k',
      tenant: 't',
      fetch: (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch,
    });
    await expect(c.getWilayas()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('requires credentials', () => {
    expect(() => createClient('zrexpress', { apiKey: '', tenant: 't' })).toThrow(ShippingError);
  });
});

describe('ZRExpress locations', () => {
  it('caches wilayas for the client lifetime', async () => {
    const { c, mock } = client([
      { status: 200, body: { items: [{ id: WILAYA, code: 16, name: 'Alger', level: 'wilaya' }], hasNext: false } },
    ]);
    await c.getWilayas();
    const second = await c.getWilayas();
    expect(second).toHaveLength(1);
    expect(mock.calls).toHaveLength(1);
  });

  it('resolves a wilaya code for getCommunes', async () => {
    const { c, mock } = client([
      { status: 200, body: { items: [{ id: WILAYA, code: 16, name: 'Alger', level: 'wilaya' }], hasNext: false } },
      {
        status: 200,
        body: { items: [{ id: COMMUNE, name: 'Sidi M’Hamed', level: 'commune', parentId: WILAYA }], hasNext: false },
      },
    ]);
    const communes = await c.getCommunes(16);
    expect(communes.map((x) => x.id)).toEqual([COMMUNE]);
    expect((mock.calls[1]!.body as any).advancedFilter.filters[1]).toEqual({
      field: 'parentId',
      operator: 'eq',
      value: WILAYA,
    });
  });
});
