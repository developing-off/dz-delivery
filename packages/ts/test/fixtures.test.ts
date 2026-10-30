import { describe, expect, it } from 'vitest';
import { createClient, ShippingError, type ShippingProvider } from '../src';
import { mapEcotrackStatus } from '../src/providers/ecotrack';
import { mapMaystroStatus } from '../src/providers/maystro';
import { mapNoestStatus } from '../src/providers/noest';
import { mapYalidineStatus } from '../src/providers/yalidine';
import { mapZRExpressStatus } from '../src/providers/zrexpress';
import { loadFixtureCases, mockFetch, readJson, stripRaw, subsetMismatches, type FixtureCase } from './helpers';

const PROVIDERS = ['zrexpress', 'yalidine', 'maystro', 'ecotrack', 'noest'] as const;
const MAPPERS = {
  zrexpress: mapZRExpressStatus,
  yalidine: mapYalidineStatus,
  maystro: mapMaystroStatus,
  ecotrack: mapEcotrackStatus,
  noest: mapNoestStatus,
};

function call(client: ShippingProvider, c: FixtureCase): Promise<unknown> {
  const input = (c.input ?? {}) as Record<string, any>;
  switch (c.method) {
    case 'createParcel':
      return client.createParcel(input as any);
    case 'track':
      return client.track(input.trackingNumber);
    case 'getFees':
      return client.getFees(input as any);
    case 'getWilayas':
      return client.getWilayas();
    case 'getCommunes':
      return client.getCommunes(input.wilayaId);
    case 'getStopDesks':
      return client.getStopDesks(input as any);
    case 'listParcels':
      return client.listParcels(input as any);
    case 'cancelParcel':
      return client.cancelParcel(input.trackingNumberOrId);
    default:
      throw new Error(`Unknown fixture method ${c.method}`);
  }
}

for (const provider of PROVIDERS) {
  describe(`${provider} shared fixtures`, () => {
    const config = readJson<Record<string, unknown>>(provider, 'config.json');

    for (const c of loadFixtureCases(provider)) {
      it(`${c.method} / ${c.name}`, async () => {
        const mock = mockFetch(c.native);
        const client = createClient(provider, { ...config, ...c.config, fetch: mock.fetch } as any);

        let result: unknown;
        let error: unknown;
        try {
          result = await call(client, c);
        } catch (err) {
          error = err;
        }

        // Requests, in order.
        expect(mock.calls.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(
          c.requests.map((r) => `${r.method} ${r.path}`),
        );
        c.requests.forEach((expected, i) => {
          const actual = mock.calls[i]!;
          if (expected.query) {
            for (const [k, v] of Object.entries(expected.query)) {
              expect(actual.url.searchParams.get(k), `query ${k}`).toBe(String(v));
            }
          }
          if (expected.headers) {
            for (const [k, v] of Object.entries(expected.headers)) {
              expect(actual.headers[k.toLowerCase()], `header ${k}`).toBe(v);
            }
          }
          if ('body' in expected) {
            expect(subsetMismatches(expected.body, actual.body), `request #${i} body`).toEqual([]);
          }
        });

        if (c.expected.error) {
          expect(error, 'expected an error').toBeInstanceOf(ShippingError);
          const e = error as ShippingError;
          expect(e.provider).toBe(provider);
          for (const [k, v] of Object.entries(c.expected.error)) {
            expect((e as unknown as Record<string, unknown>)[k], `error.${k}`).toEqual(v);
          }
        } else {
          if (error) throw error;
          if (c.expected.result === null) {
            expect(result).toBeUndefined();
          } else {
            expect(stripRaw(result)).toEqual(c.expected.result);
          }
        }
      });
    }

    it('maps every native status in statuses.json', () => {
      const table = readJson<Record<string, string>>(provider, 'statuses.json');
      for (const [native, unified] of Object.entries(table)) {
        expect(MAPPERS[provider](native), native).toBe(unified);
      }
    });
  });
}
