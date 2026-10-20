import { describe, expect, it } from 'vitest';
import { createClient, mapMaystroStatus, ShippingError } from '../src';
import { mockFetch } from './helpers';

describe('maystro', () => {
  it('maps numeric webhook status codes', () => {
    expect(mapMaystroStatus(41)).toBe('delivered');
    expect(mapMaystroStatus(4)).toBe('pending');
    expect(mapMaystroStatus(7)).toBe('unknown');
    expect(mapMaystroStatus(null)).toBe('unknown');
  });

  it('does not double the Token prefix', async () => {
    const mock = mockFetch([{ status: 200, body: [[16, 'Alger']] }]);
    await createClient('maystro', { apiToken: 'Token abc', fetch: mock.fetch }).getWilayas();
    expect(mock.calls[0]!.headers.authorization).toBe('Token abc');
  });

  it('requires apiToken', () => {
    expect(() => createClient('maystro', { apiToken: ' ' })).toThrow(ShippingError);
  });

  it('reads order error codes from a 400 response body', async () => {
    const mock = mockFetch([
      { status: 200, body: [[16, 'Alger']] },
      { status: 200, body: [{ id: 554, wilaya: 16, name: 'Alger Centre' }] },
      { status: 400, body: [{ success: false, errors: [10] }] },
    ]);
    const client = createClient('maystro', { apiToken: 't', fetch: mock.fetch });
    const err = await client
      .createParcel({
        recipientName: 'Test',
        phone: '0550123456',
        address: 'x',
        wilayaId: 16,
        communeId: 554,
        productName: 'Mug',
        price: 1000,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ShippingError);
    expect(err).toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
      message: 'Order price is not valid or it was not defined',
      details: [{ field: 'price', message: 'Order price is not valid or it was not defined', code: '10' }],
    });
  });
});
