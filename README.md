# dz-delivery — SDK livraison Algérie (Yalidine, ZRExpress, Maystro, Ecotrack, NoEST, E-com)

[![npm](https://img.shields.io/npm/v/@dz-delivery/core?label=npm%20%40dz-delivery%2Fcore)](https://www.npmjs.com/package/@dz-delivery/core)
[![Packagist](https://img.shields.io/packagist/v/dz-delivery/sdk?label=packagist%20dz-delivery%2Fsdk)](https://packagist.org/packages/dz-delivery/sdk)
[![CI](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> One SDK, every Algerian shipping carrier. Available for **TypeScript / Node.js** (npm) and **PHP / Laravel** (Composer).
>
> Un seul SDK pour créer, suivre et tarifer des colis avec les transporteurs algériens.

🌐 **Docs & site : <https://developing-off.github.io/dz-delivery/>**

`dz-delivery` gives e-commerce developers in Algeria a **single, simple interface** to create parcels, track shipments, quote fees and list wilayas/communes — regardless of which carrier is behind it.

It is **not** a 1:1 wrapper of every carrier endpoint. It focuses on the handful of operations every shop needs, with the same names and shapes in TypeScript and PHP.

## Install

```bash
npm install @dz-delivery/core      # TypeScript / Node.js ≥ 18, zero runtime dependencies
composer require dz-delivery/sdk   # PHP ≥ 8.2 (Guzzle 7)
```

## Supported carriers

<p align="center">
  <a href="https://developing-off.github.io/dz-delivery/yalidine/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/yalidine.png" alt="Yalidine" title="Yalidine" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/zrexpress/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/zrexpress.png" alt="ZRExpress" title="ZRExpress" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/maystro/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/maystro.png" alt="Maystro Delivery" title="Maystro Delivery" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/ecotrack/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecotrack.png" alt="Ecotrack" title="Ecotrack" height="60"></a>
  <a href="https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md#noest"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/noest.png" alt="NoEST" title="NoEST" height="60"></a>
  <a href="https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md#ecom"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecom.png" alt="E-com Delivery" title="E-com Delivery" height="60"></a>
</p>

<p align="center"><sub>Logos are trademarks of their respective owners, shown only to indicate which carriers the SDK works with. dz-delivery is an independent open-source project, not affiliated with or endorsed by these companies.</sub></p>

| Carrier | Key | TypeScript | PHP | Guide |
|---------|-----|------------|-----|-------|
| Yalidine | `yalidine` | yes | yes | [Yalidine API](https://developing-off.github.io/dz-delivery/yalidine/) |
| GuepEx (Yalidine platform) | `yalidine` + GuepEx `baseUrl` | yes | yes | [Yalidine API](https://developing-off.github.io/dz-delivery/yalidine/#guepex) |
| ZRExpress | `zrexpress` | yes (+ bulk, labels, webhooks) | yes (+ bulk, labels, webhooks) | [ZRExpress API](https://developing-off.github.io/dz-delivery/zrexpress/) |
| Maystro Delivery | `maystro` | yes (track / cancel via webhooks) | yes (track / cancel via webhooks) | [Maystro API](https://developing-off.github.io/dz-delivery/maystro/) |
| Ecotrack (DHD, Anderson, World Express, 48Hr Express, EcoRapid, Conexlog, MSM Go, Packers, …) | `ecotrack` | yes | yes | [Ecotrack API](https://developing-off.github.io/dz-delivery/ecotrack/) |
| NoEST | `noest` | yes (no `listParcels`) | yes (no `listParcels`) | [PROVIDERS.md](./docs/PROVIDERS.md#noest) |
| E-com Delivery | `ecom` | yes (+ `listParcels`) | yes (+ `listParcels`) | [PROVIDERS.md](./docs/PROVIDERS.md#ecom) |
| MDM, Elogistia… | — | backlog | backlog | |

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

> **Status:** `0.x` — the API may still change between minor versions. Tests replay shared fixtures (mocked HTTP, no network) in both languages. Reports with anonymized real carrier responses are very welcome, see [`TASKS.md`](./TASKS.md).

## Quickstart

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

Full TypeScript reference: [`packages/ts/README.md`](./packages/ts/README.md).

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

## FAQ

**How do I use the Yalidine API in Node.js or PHP?**
`createClient('yalidine', { apiId, apiToken, fromWilayaId })` in TypeScript, `ClientFactory::create('yalidine', [...])` in PHP. See the [Yalidine guide](https://developing-off.github.io/dz-delivery/yalidine/).

**Comment intégrer l'API ZR Express dans mon site e-commerce ?**
Installez `@dz-delivery/core` (Node.js) ou `dz-delivery/sdk` (PHP / Laravel), puis créez un client `zrexpress` avec votre `apiKey` et votre `tenant`. Voir le [guide ZRExpress](https://developing-off.github.io/dz-delivery/zrexpress/).

**Does it work with DHD and other Ecotrack couriers?**
Yes — one `ecotrack` provider covers every courier on the Ecotrack platform, with a built-in `courier` key (`dhd`, `anderson`, `worldexpress`, …) or your tenant `baseUrl`. See the [Ecotrack guide](https://developing-off.github.io/dz-delivery/ecotrack/).

**Can I switch carriers without rewriting my code?**
Yes. Every carrier returns the same models and the same normalized statuses, so only the client configuration changes.

**Est-ce que ça marche avec Laravel, WooCommerce ou Shopify ?**
Le SDK PHP fonctionne dans n'importe quel projet Composer (exemple Laravel dans le [guide PHP](./docs/guide-php.md#6-laravel-example)). Pour Shopify ou un backend Node, utilisez le package npm.

## Repository layout

```
docs/            Shared contract, provider mapping, test fixtures
packages/ts/     TypeScript package (@dz-delivery/core)
packages/php/    PHP package (dz-delivery/sdk)
examples/ts/     TypeScript examples
examples/php/    PHP examples
```

## Contributing

Contributions are very welcome — especially new providers. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [`CHANGELOG`](./CHANGELOG.md).

## License

[MIT](./LICENSE) © 2026 dz-delivery contributors
