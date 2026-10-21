# dz-delivery

> One SDK, every Algerian shipping carrier. Available for **TypeScript** (npm) and **PHP** (Composer).

`dz-delivery` gives e-commerce developers in Algeria a **single, simple interface** to create parcels, track shipments, quote fees and list wilayas/communes — regardless of which carrier is behind it.

It is **not** a 1:1 wrapper of every carrier endpoint. It focuses on the handful of operations every shop needs, with the same names and shapes in TypeScript and PHP.

> **Status:** MVP implemented (mocked tests). Yalidine mapping is checked against its developer docs; error bodies still need real responses. See [`TASKS.md`](./TASKS.md).

## Supported providers (MVP)

| Provider   | TypeScript | PHP     |
|------------|------------|---------|
| ZRExpress  | yes        | yes     |
| Yalidine   | yes | yes |
| Maystro Delivery | yes (track / cancel not supported) | yes (track / cancel not supported) |
| Ecotrack (DHD, Conexlog, MSM Go, Packers, World Express, …) | yes | yes |
| Other carriers | backlog | backlog |

## The unified API

Every provider implements the same `ShippingProvider` interface:

| # | Operation | Method(s) |
|---|-----------|-----------|
| 1 | Create a parcel | `createParcel(input)` |
| 2 | Track a parcel | `track(trackingNumber)` |
| 3 | Quote delivery fees | `getFees(query)` |
| 4 | List locations | `getWilayas()` / `getCommunes(wilayaId)` / `getStopDesks({ wilayaId, communeId? })` |
| 5 | List account parcels | `listParcels(query?)` |
| 6 | Cancel a parcel | `cancelParcel(trackingNumberOrId)` |
| 7 | Health probe | `healthCheck()` |

Statuses are normalized to: `pending | created | in_transit | delivered | returned | cancelled | unknown`.
Every returned object can carry an optional `raw` field with the native API response for power users.

📄 **The source of truth is [`docs/CONTRACT.md`](./docs/CONTRACT.md).** Provider-specific endpoint mapping lives in [`docs/PROVIDERS.md`](./docs/PROVIDERS.md). ZRExpress extras (bulk, labels, webhooks): [`docs/ZREXPRESS.md`](./docs/ZREXPRESS.md).

## Quickstart

> ⚠️ Packages are not published yet — these snippets show the target API.

Copy `.env.example` to `.env` and fill in your credentials.

### TypeScript

```ts
import { createClient } from '@dz-delivery/core';

const shipping = createClient('zrexpress', {
  apiKey: process.env.ZREXPRESS_API_KEY!,
  tenant: process.env.ZREXPRESS_TENANT!,
});

const parcel = await shipping.createParcel({
  recipientName: 'Amine B.',
  phone: '0550123456',
  address: '12 rue Didouche Mourad',
  wilayaId: 16,
  communeName: 'Alger Centre',
  productName: 'T-shirt',
  price: 2500,
});

const { parcel: current, events } = await shipping.track(parcel.trackingNumber);
console.log(current.status, events);
```

### PHP

```php
use DzDelivery\ClientFactory;

$shipping = ClientFactory::create('zrexpress', [
    'apiKey' => getenv('ZREXPRESS_API_KEY'),
    'tenant' => getenv('ZREXPRESS_TENANT'),
]);

$parcel = $shipping->createParcel([
    'recipientName' => 'Amine B.',
    'phone'         => '0550123456',
    'address'       => '12 rue Didouche Mourad',
    'wilayaId'      => 16,
    'communeName'   => 'Alger Centre',
    'productName'   => 'T-shirt',
    'price'         => 2500,
]);

$result = $shipping->track($parcel->trackingNumber);
echo $result->parcel->status;
```

Full PHP guide (install, every method, errors, Laravel, webhooks): [`docs/guide-php.md`](./docs/guide-php.md).

## Repository layout

```
docs/            Shared contract, provider mapping, test fixtures
packages/ts/     TypeScript package (@dz-delivery/core)
packages/php/    PHP package (dz-delivery/sdk)
examples/ts/     TypeScript examples
examples/php/    PHP examples
```

## Contributing

Contributions are very welcome — especially new providers. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Site

Documentation (GitHub Pages) : [`index.html`](./index.html) — install, API unifiée, modèles, erreurs, matrice providers, extras ZRExpress.  
Activer dans **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.  
URL typique : `https://developing-off.github.io/dz-delivery/`.

## License

[MIT](./LICENSE) © 2026 dz-delivery contributors
