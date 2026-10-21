import { describe, expect, it } from 'vitest';
import { createClient, createZRExpress, ShippingError } from '../src';
import { mockFetch, readJson } from './helpers';
import type { ZRExpressProvider } from '../src/providers/zrexpress';

const WILAYA = '11111111-1111-4111-8111-000000000016';
const COMMUNE = '22222222-2222-4222-8222-000000016001';
const PARCEL = '8c1a4c53-0000-4000-8000-000000000001';

function client(responses: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const mock = mockFetch(responses);
  const c = createClient('zrexpress', { apiKey: 'k', tenant: 't', fetch: mock.fetch, ...extra });
  return { c, mock };
}

function zrClient(responses: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
  const mock = mockFetch(responses);
  const c = createZRExpress({ apiKey: 'k', tenant: 't', fetch: mock.fetch, ...extra });
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

describe('ZRExpress stockType', () => {
  it('defaults orderedProducts stockType to none', async () => {
    const { c, mock } = client([
      { status: 201, body: { id: PARCEL } },
      { status: 200, body: { id: PARCEL, trackingNumber: 'DZ-1', state: { name: 'OrderReceived' } } },
    ]);
    await c.createParcel(baseInput);
    const products = (mock.calls[0]!.body as any).orderedProducts;
    expect(products[0].stockType).toBe('none');
  });

  it('forwards ParcelInput.stockType and ProductItem catalog fields', async () => {
    const { c, mock } = client([
      { status: 201, body: { id: PARCEL } },
      { status: 200, body: { id: PARCEL, trackingNumber: 'DZ-1', state: { name: 'OrderReceived' } } },
    ]);
    const { productName, ...rest } = baseInput;
    await c.createParcel({
      ...rest,
      stockType: 'local',
      productList: [
        {
          name: 'Chocolat',
          quantity: 2,
          unitPrice: 500,
          sku: 'CHOCO-1',
          productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ],
    });
    expect((mock.calls[0]!.body as any).orderedProducts[0]).toMatchObject({
      productName: 'Chocolat',
      stockType: 'local',
      productSku: 'CHOCO-1',
      productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('rejects local stockType without productId and sku before any HTTP call', async () => {
    const { c, mock } = client([]);
    await expect(c.createParcel({ ...baseInput, stockType: 'local' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'productName.productId' }),
        expect.objectContaining({ field: 'productName.sku' }),
      ]),
    });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('ZRExpress getStopDesks', () => {
  it('maps hub phone, hours, coordinates and type', async () => {
    const { c } = client([
      { status: 200, body: { items: [{ id: WILAYA, code: 16, name: 'Alger', level: 'wilaya' }], hasNext: false } },
      {
        status: 200,
        body: {
          items: [
            {
              id: '33333333-3333-4333-8333-000000000001',
              name: 'Bureau Test',
              type: 'stopdesk',
              isPickupPoint: true,
              openingHours: '08:30-16:30',
              phone: { number1: '+213555000000' },
              address: {
                street: '1 rue Test',
                cityTerritoryId: WILAYA,
                districtTerritoryId: COMMUNE,
                coordinates: { lat: 36.7, lng: 3.1 },
              },
            },
          ],
          hasNext: false,
        },
      },
    ]);
    const desks = await c.getStopDesks({ wilayaId: 16 });
    expect(desks).toEqual([
      expect.objectContaining({
        id: '33333333-3333-4333-8333-000000000001',
        phone: '+213555000000',
        openingHours: '08:30-16:30',
        lat: 36.7,
        lng: 3.1,
        type: 'stopdesk',
      }),
    ]);
  });

  it('throws NOT_FOUND with EMPTY_COMMUNE_HUBS when commune is empty but wilaya has hubs', async () => {
    const emptyCommune = '22222222-2222-4222-8222-000000016099';
    const { c, mock } = client([
      { status: 200, body: { items: [{ id: WILAYA, code: 16, name: 'Alger', level: 'wilaya' }], hasNext: false } },
      { status: 200, body: { items: [], hasNext: false } },
      {
        status: 200,
        body: {
          items: [
            {
              id: '33333333-3333-4333-8333-000000000001',
              name: 'Bureau',
              isPickupPoint: true,
              address: { cityTerritoryId: WILAYA, districtTerritoryId: COMMUNE },
            },
          ],
          hasNext: false,
        },
      },
    ]);
    await expect(c.getStopDesks({ wilayaId: 16, communeId: emptyCommune })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: [{ field: 'communeId', code: 'EMPTY_COMMUNE_HUBS' }],
    });
    expect(mock.calls).toHaveLength(3);
  });
});

describe('ZRExpress extras — labels', () => {
  it('generateLabels multiple returns fileUrl', async () => {
    const native = readJson<Parameters<typeof mockFetch>[0]>('zrexpress/generateLabels/multiple.native.json');
    const { c, mock } = zrClient(native);
    const result = await c.generateLabels(['16-AAA111-ZR', '16-MISSING-ZR']);
    expect(result.fileUrl).toContain('bordereaux_multiple');
    expect(result.failedTrackingNumbers).toEqual(['16-MISSING-ZR']);
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/parcels/labels/multiple');
    expect(mock.calls[0]!.headers['x-api-key']).toBe('k');
  });

  it('generateLabels individual returns per-tracking URLs', async () => {
    const native = readJson<Parameters<typeof mockFetch>[0]>('zrexpress/generateLabels/individual.native.json');
    const { c, mock } = zrClient(native);
    const result = await c.generateLabels(['16-AAA111-ZR'], { mode: 'individual' });
    expect(result.labels).toEqual([
      {
        trackingNumber: '16-AAA111-ZR',
        fileUrl: 'https://zrexpressstorage.blob.core.windows.net/labels/bordereau_16-AAA111-ZR.html?sv=demo',
      },
    ]);
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/parcels/labels/individual');
  });
});

describe('ZRExpress extras — bulk', () => {
  const bulkInput = {
    ...baseInput,
    orderId: 'ORD-BULK-1',
  };

  it('createParcelsBulk maps partial success (207)', async () => {
    const native = readJson<Parameters<typeof mockFetch>[0]>('zrexpress/createParcelsBulk/partial.native.json');
    const { c, mock } = zrClient(native);
    const result = await c.createParcelsBulk([
      { ...bulkInput, orderId: 'ORD-BULK-1' },
      { ...bulkInput, orderId: 'ORD-BULK-2' },
    ]);
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0]).toMatchObject({
      id: PARCEL,
      trackingNumber: '16-BULK001-ZR',
      status: 'pending',
      provider: 'zrexpress',
    });
    expect(result.failures).toEqual([
      {
        index: 1,
        orderId: 'ORD-BULK-2',
        error: {
          code: 'PROVIDER_ERROR',
          message: 'externalId already exists',
          errorCode: 'ParcelErrors.DuplicateExternalId',
        },
      },
    ]);
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/parcels/bulk');
    expect((mock.calls[0]!.body as { parcels: unknown[] }).parcels).toHaveLength(2);
  });

  it('createParcelsBulk returns failures on HTTP 400 report without throwing', async () => {
    const native = readJson<Parameters<typeof mockFetch>[0]>('zrexpress/createParcelsBulk/all-failed.native.json');
    const { c } = zrClient(native);
    const result = await c.createParcelsBulk([{ ...bulkInput, orderId: 'ORD-FAIL' }]);
    expect(result.successes).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      index: 0,
      orderId: 'ORD-FAIL',
      error: { errorCode: 'ParcelErrors.Validation' },
    });
  });

  it('createParcelsBulk requires orderId before HTTP', async () => {
    const { c, mock } = zrClient([]);
    await expect(c.createParcelsBulk([baseInput])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'inputs[0].orderId' }],
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('deleteParcelsBulk splits UUID vs tracking and remaps indices', async () => {
    const native = readJson<Parameters<typeof mockFetch>[0]>('zrexpress/deleteParcelsBulk/mixed.native.json');
    const { c, mock } = zrClient(native);
    const result = await c.deleteParcelsBulk([PARCEL, '16-MISSING-ZR']);
    expect(result.successes).toEqual([
      { index: 0, parcelId: PARCEL, trackingNumber: '16-DEL001-ZR' },
    ]);
    expect(result.failures).toEqual([
      {
        index: 1,
        error: {
          code: 'PROVIDER_ERROR',
          message: "Parcel with tracking number '16-MISSING-ZR' was not found",
          errorCode: 'ParcelErrors.NotFound',
        },
      },
    ]);
    expect(mock.calls[0]!.method).toBe('DELETE');
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/parcels/bulk');
    expect(mock.calls[1]!.url.pathname).toBe('/api/v1/parcels/bulk/by-tracking-number');
  });

  it('createZRExpress returns ZRExpressProvider', () => {
    const c = createZRExpress({ apiKey: 'k', tenant: 't', fetch: mockFetch([]).fetch });
    expect(c.name).toBe('zrexpress');
    expect(typeof (c as ZRExpressProvider).generateLabels).toBe('function');
  });
});
