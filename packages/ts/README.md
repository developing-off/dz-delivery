# @dz-delivery/core — Algerian delivery SDK for TypeScript / Node.js

[![npm](https://img.shields.io/npm/v/@dz-delivery/core)](https://www.npmjs.com/package/@dz-delivery/core)
[![CI](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/developing-off/dz-delivery/blob/main/LICENSE)

One API for Algerian delivery carriers — **Yalidine, GuepEx, ZRExpress, Maystro, Ecotrack (DHD, Anderson, World Express, …), NoEST, E-com Delivery**.
Create parcels, track shipments, quote fees and list wilayas / communes / stop desks with the same code for every carrier.

> 🇩🇿 SDK livraison Algérie : un seul code pour créer, suivre et tarifer vos colis chez tous les transporteurs.
> Docs : <https://developing-off.github.io/dz-delivery/> · PHP / Laravel : [`dz-delivery/sdk`](https://packagist.org/packages/dz-delivery/sdk)

Implements the shared contract in
[`docs/CONTRACT.md`](https://github.com/developing-off/dz-delivery/blob/main/docs/CONTRACT.md); carrier-specific mappings are in
[`docs/PROVIDERS.md`](https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md).

<p align="center">
  <a href="https://developing-off.github.io/dz-delivery/yalidine/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/yalidine.png" alt="Yalidine" title="Yalidine" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/zrexpress/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/zrexpress.png" alt="ZRExpress" title="ZRExpress" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/maystro/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/maystro.png" alt="Maystro Delivery" title="Maystro Delivery" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/ecotrack/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecotrack.png" alt="Ecotrack" title="Ecotrack" height="60"></a>
  <a href="https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md#noest"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/noest.png" alt="NoEST" title="NoEST" height="60"></a>
  <a href="https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md#ecom"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecom.png" alt="E-com Delivery" title="E-com Delivery" height="60"></a>
</p>

<p align="center"><sub>Logos are trademarks of their respective owners, shown only to indicate which carriers the SDK works with. dz-delivery is an independent open-source project, not affiliated with or endorsed by these companies.</sub></p>

| Provider | Key | Status |
|----------|-----|--------|
| ZRExpress | `zrexpress` | ✅ contrat unifié (create, track, fees, locations, stop desks, list, cancel, health) + [extras](https://github.com/developing-off/dz-delivery/blob/main/docs/ZREXPRESS.md) (bulk, labels, webhooks) |
| Yalidine | `yalidine` | ✅ contrat unifié (mapping checked against the developer docs, see PROVIDERS.md) |
| Maystro Delivery | `maystro` | ✅ createParcel, getFees, getWilayas, getCommunes, getStopDesks — `track` / `cancelParcel` throw `NOT_SUPPORTED` (webhooks only) |
| Ecotrack (DHD, Conexlog, …) | `ecotrack` | ✅ contrat unifié — one provider for every courier on the Ecotrack platform (`courier` or `baseUrl`) |
| NoEST | `noest` | ✅ contrat unifié — `listParcels` throws `NOT_SUPPORTED` (no list endpoint) |
| E-com Delivery | `ecom` | ✅ contrat unifié, including `listParcels` |

- ESM + CommonJS, bundled type definitions
- Node.js ≥ 18 (uses global `fetch`), no runtime dependencies

## Install

```bash
npm install @dz-delivery/core
```

## Usage

```ts
import { createClient, createZRExpress, isShippingError } from '@dz-delivery/core';

const zr = createClient('zrexpress', {
  apiKey: process.env.ZREXPRESS_API_KEY!,
  tenant: process.env.ZREXPRESS_TENANT!,
});
// Extras ZR (bulk / labels / typed provider): createZRExpress({ apiKey, tenant })
// Webhooks: verifyZRExpressWebhook(rawBody, headers, secret) — see docs/ZREXPRESS.md

const yalidine = createClient('yalidine', {
  apiId: process.env.YALIDINE_API_ID!,
  apiToken: process.env.YALIDINE_API_TOKEN!,
  fromWilayaId: 16, // origin wilaya, required by Yalidine to create parcels / quote fees
  // GuepEx (same API): import { GUEPEX_DEFAULT_BASE_URL } and set baseUrl: GUEPEX_DEFAULT_BASE_URL
});

const maystro = createClient('maystro', {
  apiToken: process.env.MAYSTRO_API_TOKEN!, // sent as `Authorization: Token <apiToken>`
});
// Maystro has no tracking API: map webhook statuses yourself.
// mapMaystroStatus(payload.status) → 'delivered' for 41

const dhd = createClient('ecotrack', {
  token: process.env.ECOTRACK_TOKEN!, // sent as `Authorization: Bearer <token>`
  courier: 'dhd',                     // or baseUrl: 'https://<tenant>.ecotrack.dz'
  // autoValidate: true,              // hand orders to the courier right after creation
});

// Locations
const wilayas = await zr.getWilayas();           // [{ id, name, code: '16', raw }]
const communes = await zr.getCommunes(16);       // provider id or official code 1–58

// Fees
const quote = await zr.getFees({ toWilayaId: 16, isStopDesk: false });
// { deliveryFee: 400, stopDeskFee: 250, currency: 'DZD', raw }

// Create a parcel (ids, official codes or names are accepted)
const parcel = await zr.createParcel({
  recipientName: 'Mohamed Amine',
  phone: '0550 12 34 56',          // normalized to the carrier's format
  address: 'Cité 221 lots, n°98',
  wilayaName: 'Alger',
  communeName: 'Bab Ezzouar',
  productName: 'T-shirt',
  price: 2500,                     // amount collected from the recipient (DZD)
  orderId: 'ORDER-1001',
});
// { id, trackingNumber: 'DZ-AL-…', status: 'pending', provider: 'zrexpress', raw }

// Track
const { parcel: current, events } = await zr.track(parcel.trackingNumber);
// events are sorted oldest first: [{ status: 'pending', label: 'Commande reçue', at: '2025-…+00:00' }, …]

// Cancel (tracking number or internal id)
await zr.cancelParcel(parcel.trackingNumber);
```

### Methods

Every provider implements `ShippingProvider`:

| Method | Returns |
|--------|---------|
| `createParcel(input: ParcelInput)` | `Promise<Parcel>` |
| `track(trackingNumber)` | `Promise<{ parcel, events }>` |
| `getFees(query: FeeQuery)` | `Promise<FeeQuote>` |
| `getWilayas()` | `Promise<Location[]>` (cached per client) |
| `getCommunes(wilayaId)` | `Promise<Location[]>` (cached per client) |
| `getStopDesks({ wilayaId, communeId? })` | `Promise<StopDesk[]>` — `id` is the `stopDeskId` to send (ZRExpress hubs: prefer wilaya-only; Yalidine centers; Maystro needs `communeId`; Ecotrack communes with a stop desk). Optional fields: `phone`, `openingHours`, `lat`, `lng`, `type`. |
| `listParcels(query?)` | `Promise<ParcelListPage>` — paginated account parcels + unified status (ZRExpress via `parcels/search`; others `NOT_SUPPORTED` for now). No event history — use `track()`. |
| `cancelParcel(trackingNumberOrId)` | `Promise<void>` |
| `healthCheck()` | `Promise<{ ok: true, provider, latencyMs }>` — authenticated connectivity probe (wilayas listing, cache bypassed) |

Statuses are unified: `pending | created | in_transit | delivered | returned | cancelled | unknown`.
An unmapped native status never throws — it maps to `unknown` and the native label stays in
`TrackingEvent.label` / `raw`.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | carrier default | Override the API base URL (sandbox, proxy). |
| `timeoutMs` | `15000` | HTTP timeout. |
| `includeRaw` | `true` | Attach the native response as `raw` on every returned model. |
| `fetch` | `globalThis.fetch` | Custom fetch implementation (tests, proxies). |

Provider credentials: `zrexpress` → `apiKey`, `tenant`; `yalidine` → `apiId`, `apiToken`
(+ `fromWilayaId` or `fromWilayaName`); `maystro` → `apiToken`; `ecotrack` → `token` + exactly one of
`courier` (`dhd`, `anderson`, `worldexpress`, `48hrexpress`, `ecorapid`, `conexlog`, `msmgo`, `packers`, `rocketdelivery`; alias `andersondelivery`) or
`baseUrl` (any tenant, `https` only), optional `autoValidate`; `noest` → `apiToken`, `userGuid`, optional `autoValidate`; `ecom` → `apiKey`, `apiToken`, optional `autoValidate`.

### Errors

Every failure is a `ShippingError` with a normalized `code`:

```ts
try {
  await zr.track('DZ-UNKNOWN');
} catch (err) {
  if (isShippingError(err)) {
    err.code;       // 'NOT_FOUND' | 'AUTH_FAILED' | 'VALIDATION_ERROR' | 'RATE_LIMITED' | 'NOT_SUPPORTED' | 'PROVIDER_ERROR' | 'NETWORK_ERROR' | 'UNKNOWN'
    err.httpStatus; // 404
    err.details;    // e.g. [{ field: 'phone', message: '…' }] for validation errors
    err.raw;        // native error body
  }
}
```

Input is validated before any HTTP call (`VALIDATION_ERROR`), and wilaya/commune names that
cannot be resolved throw `NOT_FOUND`.

## Development

```bash
npm install
npm test          # vitest — mocked fetch, no network
npm run typecheck
npm run build     # tsup → dist/ (ESM + CJS + .d.ts)
```

Tests replay the shared fixtures in [`docs/fixtures/`](https://github.com/developing-off/dz-delivery/tree/main/docs/fixtures) (also used by the
PHP package), so both implementations produce the same output for the same native responses.

A runnable example lives in [`examples/ts/quickstart.ts`](https://github.com/developing-off/dz-delivery/blob/main/examples/ts/quickstart.ts).
