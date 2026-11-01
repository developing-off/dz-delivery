import { describe, expect, it } from 'vitest';
import { createClient, mapMaystroStatus, MaystroProvider, ShippingError } from '../src';
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

  it('reads orders on the backend host and history on b.maystro-delivery.com', async () => {
    const id = '1394335a-4470-407c-a464-d90932de5510';
    const mock = mockFetch([
      { status: 200, body: { id, display_id: '172316976800001', status: 4 } },
      { status: 200, body: [{ status: 4, created_at: '2026-10-20T09:12:13+01:00', comment: null }] },
      { status: 200, body: { order_id: id, new_status: 50, old_status: 4 } },
    ]);
    const client = createClient('maystro', { apiToken: 't', fetch: mock.fetch });
    await client.track(id);
    await client.cancelParcel(id);
    expect(mock.calls.map((c) => c.url.href)).toEqual([
      `https://backend.maystro-delivery.com/api/stores/orders/${id}/`,
      `https://b.maystro-delivery.com/api/stores/history_order/${id}`,
      `https://backend.maystro-delivery.com/api/shared/status/${id}/`,
    ]);
  });

  describe('getLabels', () => {
    const id = '1394335a-4470-407c-a464-d90932de5510';
    // Shapes seen live: a label page embeds its barcode image; "no order found" is one blank page.
    const pdf = (pages: number) =>
      `%PDF-1.4\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj <</Type /Page /Parent 2 0 R>> endobj\n<</Subtype /Image>>\n`).join('')}2 0 obj <</Type /Pages /Count ${pages}>> endobj\n%%EOF`;
    const blank = '%PDF-1.4\n3 0 obj <</Type /Page /Parent 2 0 R>> endobj\n2 0 obj <</Type /Pages /Count 1>> endobj\n%%EOF';
    const provider = (mock: ReturnType<typeof mockFetch>) => new MaystroProvider({ apiToken: 't', fetch: mock.fetch });

    it('posts tracking numbers to starter_bordureau and returns the PDF bytes', async () => {
      const mock = mockFetch([{ status: 200, headers: { 'content-type': 'application/pdf' }, rawBody: pdf(2) }]);
      const labels = await provider(mock).getLabels(['172316976800001', ' 172316976800002 ', '172316976800001']);
      expect(mock.calls[0]!.method).toBe('POST');
      expect(mock.calls[0]!.url.href).toBe('https://backend.maystro-delivery.com/api/delivery/starter/starter_bordureau/');
      expect(mock.calls[0]!.body).toEqual({ orders_ids: ['172316976800001', '172316976800002'] });
      expect(mock.calls[0]!.headers.accept).toBe('*/*'); // `application/pdf` gets HTTP 406 live
      expect(labels.contentType).toBe('application/pdf');
      expect(labels.labelCount).toBe(2);
      expect(new TextDecoder('latin1').decode(labels.data)).toBe(pdf(2));
    });

    it('posts order UUIDs to the v2 endpoint', async () => {
      const mock = mockFetch([{ status: 200, rawBody: pdf(1) }]);
      const labels = await provider(mock).getLabels([id]);
      expect(mock.calls[0]!.url.pathname).toBe('/api/delivery/starter/v2/starter_bordureau/');
      expect(mock.calls[0]!.body).toEqual({ orders_ids: [id] });
      expect(labels.labelCount).toBe(1);
    });

    it('turns UUIDs into tracking numbers when references are mixed', async () => {
      const mock = mockFetch([
        { status: 200, body: { id, display_id: '172316976800001', status: 4 } },
        { status: 200, rawBody: pdf(2) },
      ]);
      await provider(mock).getLabels([id, '172316976800002']);
      expect(mock.calls[0]!.url.pathname).toBe(`/api/stores/orders/${id}/`);
      expect(mock.calls[1]!.url.pathname).toBe('/api/delivery/starter/starter_bordureau/');
      expect(mock.calls[1]!.body).toEqual({ orders_ids: ['172316976800001', '172316976800002'] });
    });

    it('drops an unknown UUID from a mixed request and still returns the other labels', async () => {
      const mock = mockFetch([
        { status: 404, body: { detail: 'Pas trouvé.', status_code: 404 } },
        { status: 200, rawBody: pdf(1) },
      ]);
      const labels = await provider(mock).getLabels([id, '172316976800002']);
      expect(mock.calls[1]!.body).toEqual({ orders_ids: ['172316976800002'] });
      expect(labels.labelCount).toBe(1);
    });

    it('maps a failed or timed-out PDF download to NETWORK_ERROR', async () => {
      const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: () =>
            new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
        }) as unknown as Response) as typeof fetch;
      const slow = new MaystroProvider({ apiToken: 't', fetch: fetchImpl, timeoutMs: 20 });
      await expect(slow.getLabels(['1'])).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Request timed out after 20 ms' });
    });

    it('throws NOT_FOUND on the blank page Maystro returns when no order matches', async () => {
      const mock = mockFetch([{ status: 200, rawBody: blank }]);
      await expect(provider(mock).getLabels(['111'])).rejects.toMatchObject({ code: 'NOT_FOUND', provider: 'maystro' });
    });

    it('rejects an empty list without calling Maystro', async () => {
      const mock = mockFetch([]);
      await expect(provider(mock).getLabels([' '])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(mock.calls).toHaveLength(0);
    });

    it('maps a JSON error body like any other call', async () => {
      const mock = mockFetch([{ status: 401, body: { detail: 'Token non valide.', status_code: 401 } }]);
      await expect(provider(mock).getLabels(['1'])).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'Token non valide.' });
    });
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
