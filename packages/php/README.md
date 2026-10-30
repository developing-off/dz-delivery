# dz-delivery/sdk — Algerian delivery SDK for PHP / Laravel

[![Packagist](https://img.shields.io/packagist/v/dz-delivery/sdk)](https://packagist.org/packages/dz-delivery/sdk)
[![CI](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/developing-off/dz-delivery/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/developing-off/dz-delivery/blob/main/LICENSE)

Unified PHP client for Algerian delivery carriers — **Yalidine, GuepEx, ZRExpress, Maystro, Ecotrack (DHD, Anderson, World Express, …), NoEST, E-com Delivery, MDM, Elogistia**.

> 🇩🇿 SDK PHP livraison Algérie : créer, suivre et tarifer vos colis avec le même code pour chaque transporteur.
> Docs : <https://developing-off.github.io/dz-delivery/> · TypeScript / Node.js : [`@dz-delivery/core`](https://www.npmjs.com/package/@dz-delivery/core)

> ⭐ This repository is a read-only mirror of the PHP package. **Stars, issues and pull requests go to the main repo: [developing-off/dz-delivery](https://github.com/developing-off/dz-delivery).**

Implements the shared contract in
[`docs/CONTRACT.md`](https://github.com/developing-off/dz-delivery/blob/main/docs/CONTRACT.md); provider mappings are in
[`docs/PROVIDERS.md`](https://github.com/developing-off/dz-delivery/blob/main/docs/PROVIDERS.md).

<p align="center">
  <a href="https://developing-off.github.io/dz-delivery/yalidine/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/yalidine.png" alt="Yalidine" title="Yalidine" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/zrexpress/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/zrexpress.png" alt="ZRExpress" title="ZRExpress" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/maystro/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/maystro.png" alt="Maystro Delivery" title="Maystro Delivery" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/ecotrack/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecotrack.png" alt="Ecotrack" title="Ecotrack" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/noest/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/noest.png" alt="NoEST" title="NoEST" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/ecom/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/ecom.png" alt="E-com Delivery" title="E-com Delivery" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/mdm/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/mdm.png" alt="MDM Express" title="MDM Express" height="60"></a>
  <a href="https://developing-off.github.io/dz-delivery/elogistia/"><img src="https://raw.githubusercontent.com/developing-off/dz-delivery/main/assets/logos/elogistia.png" alt="Elogistia" title="Elogistia" height="60"></a>
</p>

<p align="center"><sub>Logos are trademarks of their respective owners, shown only to indicate which carriers the SDK works with. dz-delivery is an independent open-source project, not affiliated with or endorsed by these companies.</sub></p>

| Provider | Key | Status |
|----------|-----|--------|
| ZRExpress | `zrexpress` | contrat unifié (`getStopDesks`, `listParcels`, …) + [extras](https://github.com/developing-off/dz-delivery/blob/main/docs/ZREXPRESS.md) (bulk, labels, webhooks) |
| Yalidine | `yalidine` | contrat unifié, checked against the developer docs |
| Maystro Delivery | `maystro` | createParcel, getFees, getWilayas, getCommunes, getStopDesks — `track` / `cancelParcel` throw `NOT_SUPPORTED` (webhooks only) |
| Ecotrack (DHD, Anderson, World Express, …) | `ecotrack` | contrat unifié — one provider for every courier on the Ecotrack platform (`courier` or `baseUrl`) |
| NoEST | `noest` | contrat unifié — `listParcels` throws `NOT_SUPPORTED` (no list endpoint) |
| E-com Delivery | `ecom` | contrat unifié, including `listParcels` |
| MDM Express | `mdm` | contrat unifié (products from the MDM catalog, `storeId`) — `cancelParcel` throws `NOT_SUPPORTED` |
| Elogistia | `elogistia` | createParcel, track, getFees, getWilayas, getCommunes — `getStopDesks` / `listParcels` / `cancelParcel` throw `NOT_SUPPORTED` |

Requires PHP ≥ 8.2 and Guzzle 7.

## Install

```bash
composer require dz-delivery/sdk
```

**Full guide** (configuration, every method with input/output tables, errors, Laravel,
Maystro webhooks, testing): [`docs/guide-php.md`](https://github.com/developing-off/dz-delivery/blob/main/docs/guide-php.md).

## Usage

```php
use DzDelivery\ClientFactory;
use DzDelivery\Errors\ShippingError;

$client = ClientFactory::create('zrexpress', [
    'apiKey' => getenv('ZREXPRESS_API_KEY'),
    'tenant' => getenv('ZREXPRESS_TENANT'),
    // 'baseUrl' => ..., 'timeoutMs' => 15000, 'includeRaw' => true,
]);
// Extras ZR (bulk / labels): new \DzDelivery\Providers\ZRExpressProvider([...])
// Webhooks: \DzDelivery\Providers\ZRExpress\Webhook::verify($rawBody, $headers, $secret)
// → docs/ZREXPRESS.md

// Yalidine also needs the origin wilaya (for createParcel and getFees):
// ClientFactory::create('yalidine', ['apiId' => ..., 'apiToken' => ..., 'fromWilayaId' => 16]);
// GuepEx (same API): add 'baseUrl' => YalidineProvider::GUEPEX_DEFAULT_BASE_URL

// Ecotrack couriers (DHD, Conexlog, ...): token + 'courier' key or the tenant 'baseUrl':
// ClientFactory::create('ecotrack', ['token' => getenv('ECOTRACK_TOKEN'), 'courier' => 'dhd']);

// Maystro only needs a store token (sent as `Authorization: Token <apiToken>`):
// ClientFactory::create('maystro', ['apiToken' => getenv('MAYSTRO_API_TOKEN')]);
// It has no tracking API: map webhook statuses with StatusMapper::maystro($payload['status']).

try {
    $parcel = $client->createParcel([
        'recipientName' => 'Client Test',
        'phone' => '0550123456',          // normalized per carrier (+213… for ZRExpress)
        'address' => '12 rue des Tests',
        'wilayaId' => 16,                  // provider id or official code 1–58, or 'wilayaName'
        'communeName' => 'Bab Ezzouar',    // or 'communeId'
        'productName' => 'T-shirt',        // or 'productList' => [['name' => ..., 'quantity' => 1]]
        'price' => 2500,                   // amount collected from the recipient (DZD)
        'orderId' => 'ORD-1001',
    ]);

    $result = $client->track($parcel->trackingNumber);
    echo $result->parcel->status;          // pending | created | in_transit | delivered | returned | cancelled | unknown
    foreach ($result->events as $event) {
        echo "$event->at $event->status $event->label\n";
    }

    // weight in kg; length/width/height in cm (Yalidine bills the volumetric weight when higher)
    $quote = $client->getFees(['toWilayaId' => 16, 'isStopDesk' => false, 'weight' => 2]);
    $wilayas = $client->getWilayas();
    $communes = $client->getCommunes(16);

    // Stop desks / pickup points: use $desk->id as 'stopDeskId' with 'isStopDesk' => true.
    // ZRExpress: prefer wilaya-only (commune filter often empty). Maystro: communeId required.
    $desks = $client->getStopDesks(['wilayaId' => 16]);

    // Account parcels + status (ZRExpress). No event history — use track() for that.
    $page = $client->listParcels(['page' => 1, 'pageSize' => 50]);

    // Connectivity / credentials probe (always hits the network)
    $health = $client->healthCheck(); // { ok: true, provider, latencyMs }

    $client->cancelParcel($parcel->trackingNumber);
} catch (ShippingError $e) {
    // $e->code: AUTH_FAILED | VALIDATION_ERROR | NOT_FOUND | RATE_LIMITED | NOT_SUPPORTED
    //           | PROVIDER_ERROR | NETWORK_ERROR | UNKNOWN
    echo "$e->code: {$e->getMessage()} (HTTP $e->httpStatus)";
    // RATE_LIMITED: $e->retryAfter = seconds to wait (from the Retry-After header), when sent.
}
```

Inputs accept either arrays or the model objects (`ParcelInput`, `FeeQuery`, `StopDeskQuery`). All returned
models expose public readonly camelCase properties and an optional `raw` native payload
(disable with `'includeRaw' => false`).

A runnable example lives in [`examples/php/quickstart.php`](https://github.com/developing-off/dz-delivery/blob/main/examples/php/quickstart.php).

## Development

```bash
composer install
composer test
```

Tests use Guzzle's `MockHandler` (no network) and the shared JSON fixtures in
[`docs/fixtures/`](https://github.com/developing-off/dz-delivery/blob/main/docs/fixtures/), so they must be run from the monorepo. Pass a
Guzzle handler through the `handler` option to mock HTTP in your own tests:

```php
$stack = GuzzleHttp\HandlerStack::create(new GuzzleHttp\Handler\MockHandler([...]));
$client = ClientFactory::create('zrexpress', ['apiKey' => 'k', 'tenant' => 't', 'handler' => $stack]);
```

## Layout

```
src/
  ClientFactory.php
  Contracts/ShippingProviderInterface.php
  Models/        ParcelInput, ProductItem, Parcel, ParcelStatus, TrackingEvent, TrackResult,
                 FeeQuery, FeeQuote, Location, StopDeskQuery, StopDesk, ClientOptions
  Errors/ShippingError.php
  Http/HttpClient.php
  Providers/     ZRExpressProvider, YalidineProvider, MaystroProvider
  Support/       StatusMapper, Phone, Text, Dates
tests/
```
