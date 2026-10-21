# Using dz-delivery in a PHP project

A practical guide to calling ZRExpress, Yalidine and Maystro from your own PHP application through one API.
For the full contract see [`CONTRACT.md`](./CONTRACT.md); for carrier-specific details see [`PROVIDERS.md`](./PROVIDERS.md).

- [1. Install](#1-install)
- [2. Configure a carrier](#2-configure-a-carrier)
- [3. Methods](#3-methods)
- [4. Statuses](#4-statuses)
- [5. Error handling](#5-error-handling)
- [6. Laravel example](#6-laravel-example)
- [7. Maystro webhooks](#7-maystro-webhooks)
- [8. Testing your integration](#8-testing-your-integration)

---

## 1. Install

Requirements: **PHP ≥ 8.2**, **Guzzle 7** (pulled in by Composer).

The package (`dz-delivery/sdk`) is **not on Packagist yet**. Until it is, install it from a local checkout or from Git.

**From a local checkout** (`path` repository; changes in the SDK are visible immediately):

```json
{
  "repositories": [
    { "type": "path", "url": "../dz-delivery/packages/php" }
  ],
  "require": {
    "dz-delivery/sdk": "*@dev"
  }
}
```

**From Git** (`vcs` repository). Composer reads `composer.json` at the repository root, but the PHP package lives in `packages/php/`. Use the `path` option above, or a Git mirror/subtree split of `packages/php`:

```json
{
  "repositories": [
    { "type": "vcs", "url": "https://github.com/<your-org>/dz-delivery-php" }
  ],
  "require": {
    "dz-delivery/sdk": "dev-main"
  }
}
```

Then:

```bash
composer update dz-delivery/sdk
```

Once published on Packagist this becomes simply `composer require dz-delivery/sdk`.

Everything lives under the `DzDelivery\` namespace (PSR-4).

---

## 2. Configure a carrier

Create one client per carrier with `ClientFactory::create($provider, $options)`. Keep the credentials in environment variables or `.env` (see [`.env.example`](../.env.example)) and never hard-code them or commit them.

```php
use DzDelivery\ClientFactory;

$zr = ClientFactory::create('zrexpress', [
    'apiKey' => getenv('ZREXPRESS_API_KEY'),   // sent as X-Api-Key
    'tenant' => getenv('ZREXPRESS_TENANT'),    // sent as X-Tenant
]);

$yalidine = ClientFactory::create('yalidine', [
    'apiId'        => getenv('YALIDINE_API_ID'),     // sent as X-API-ID
    'apiToken'     => getenv('YALIDINE_API_TOKEN'),  // sent as X-API-TOKEN
    'fromWilayaId' => 16,                            // or 'fromWilayaName' => 'Alger'
]);

$maystro = ClientFactory::create('maystro', [
    'apiToken' => getenv('MAYSTRO_API_TOKEN'),  // sent as Authorization: Token <apiToken>
]);

$dhd = ClientFactory::create('ecotrack', [
    'token'   => getenv('ECOTRACK_TOKEN'),  // sent as Authorization: Bearer <token>
    'courier' => 'dhd',                     // or 'baseUrl' => 'https://<tenant>.ecotrack.dz'
    // 'autoValidate' => true,              // hand each order to the courier right after creation
]);
```

| Carrier | Required keys | Notes |
|---------|---------------|-------|
| `zrexpress` | `apiKey`, `tenant` | |
| `yalidine` | `apiId`, `apiToken` | Plus `fromWilayaId` (code `1`–`58`) **or** `fromWilayaName`: your origin wilaya, needed by `createParcel` and `getFees`. GuepEx (same API): set `'baseUrl' => YalidineProvider::GUEPEX_DEFAULT_BASE_URL`. |
| `maystro` | `apiToken` | Store token. A value already starting with `Token ` is sent unchanged. |
| `ecotrack` | `token` + exactly one of `courier` / `baseUrl` | One provider for every courier on the Ecotrack platform. `courier`: `dhd`, `anderson`, `worldexpress`, `48hrexpress`, `ecorapid`, `conexlog`, `msmgo`, `packers`, `rocketdelivery` (plus alias `andersondelivery`). Any other tenant: `baseUrl` (`https` only). `autoValidate` (default `false`): without it, orders stay `pending` until you validate them in the courier's dashboard. |

Missing credentials throw `ShippingError` with code `AUTH_FAILED` when the client is created.

Common options (all carriers):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | carrier production URL | Override the API URL (proxy, staging). |
| `timeoutMs` | `int` | `15000` | Connect + request timeout. |
| `includeRaw` | `bool` | `true` | Attach the native carrier payload as `->raw` on returned models. Set `false` to keep objects small. |
| `handler` | `callable` | — | Guzzle handler/HandlerStack, mainly for tests (see [§8](#8-testing-your-integration)). |

`ClientFactory::providers()` returns the supported keys (`['zrexpress', 'yalidine', 'maystro', 'ecotrack']`). An unknown key throws `NOT_SUPPORTED`.

Every client implements `DzDelivery\Contracts\ShippingProviderInterface`, so you can type-hint against the interface and swap carriers.

---

## 3. Methods

All methods accept either an **array** or the matching model object (`ParcelInput`, `FeeQuery`, `StopDeskQuery`). All returned models expose **public readonly camelCase properties**. Every failure throws `DzDelivery\Errors\ShippingError` (see [§5](#5-error-handling)).

### Which methods each carrier supports

| Method | ZRExpress | Yalidine | Maystro | Ecotrack |
|--------|-----------|----------|---------|----------|
| `createParcel` | yes | yes | yes | yes (`pending` until validated, see `autoValidate`) |
| `track` | yes | yes | `NOT_SUPPORTED` (use [webhooks](#7-maystro-webhooks)) | yes |
| `getFees` | yes | yes | yes | yes (per wilaya) |
| `getWilayas` / `getCommunes` | yes | yes | yes | yes |
| `getStopDesks` | yes (hubs / pickup points) | yes (centers) | yes (needs `communeId`) | yes (communes with a stop desk) |
| `cancelParcel` | yes | yes (only parcels still `En préparation`) | `NOT_SUPPORTED` | yes (only orders not validated yet) |
| `healthCheck` | yes | yes | yes | yes |

### 3.1 `createParcel(ParcelInput|array $input): Parcel`

Home delivery:

```php
$parcel = $client->createParcel([
    'recipientName' => 'Client Test',
    'phone'         => '0550123456',
    'address'       => '12 rue des Tests',
    'wilayaId'      => 16,               // or 'wilayaName' => 'Alger'
    'communeName'   => 'Bab Ezzouar',    // or 'communeId' => ...
    'productList'   => [
        ['name' => 'Mug', 'quantity' => 2],
        ['name' => 'T-shirt'],
    ],                                   // or 'productName' => 'T-shirt'
    'price'         => 3200,             // what the recipient pays, in DZD
    'weight'        => 1.5,
    'orderId'       => 'ORD-1001',
]);

echo $parcel->trackingNumber;  // store it with your order
echo $parcel->status;          // usually 'pending' right after creation
```

Stop-desk delivery: get the desk id from [`getStopDesks`](#36-getstopdesksstopdeskqueryarray-query-array) and pass it as `stopDeskId`.

```php
$desks = $yalidine->getStopDesks(['wilayaId' => 16, 'communeId' => 1630]);

$parcel = $yalidine->createParcel([
    'recipientName' => 'Client Test',
    'phone'         => '0550123456',
    'address'       => 'Retrait au bureau',
    'wilayaId'      => 16,
    'communeId'     => 1630,
    'productName'   => 'T-shirt',
    'price'         => 2500,
    'isStopDesk'    => true,
    'stopDeskId'    => $desks[0]->id,
]);
```

Input (`ParcelInput`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `recipientName` | `string` | **yes** | Full name. Yalidine splits it on the first space into first/family name. |
| `phone` | `string` | **yes** | Any common Algerian format (`0550…`, `+213 550…`). Normalized per carrier (ZRExpress gets `+213…`, the others `0…`). Invalid numbers → `VALIDATION_ERROR` before any HTTP call. |
| `phone2` | `string` | no | Second number. |
| `address` | `string` | **yes** | Free text. |
| `wilayaId` | `int\|string` | one of | Official code `1`–`58` or the carrier's `Location->id`. |
| `wilayaName` | `string` | one of | Resolved case/accent-insensitively. |
| `communeId` | `int\|string` | one of | Carrier `Location->id` from `getCommunes`. |
| `communeName` | `string` | one of | Resolved within the wilaya. |
| `productName` | `string` | one of | Single product description. |
| `productList` | `array` | one of | `[['name' => string, 'quantity' => int ≥ 1, 'unitPrice' => ?number, 'sku' => ?string], …]`. |
| `price` | `number` | **yes** | Amount collected from the recipient (COD), in DZD. `0` for prepaid. It is the total the recipient pays: carriers deduct their fee from it. |
| `weight` | `number` | no | kg. |
| `length`, `width`, `height` | `number` | no | cm. **Yalidine** always receives these four fields as integers: `0` when missing, decimals rounded up. ZRExpress puts the dimensions on the first product. Maystro ignores weight and dimensions. |
| `isStopDesk` | `bool` | no | Default `false` (home delivery). |
| `stopDeskId` | `string` | if `isStopDesk` | Desk id from `getStopDesks` (ZRExpress: the hub UUID). |
| `stockType` | `?string` | no | ZRExpress only: `"none"` (default) \| `"local"` \| `"warehouse"`. Per-item override via `productList[].stockType`; `local`/`warehouse` need `productId` + `sku`. |
| `remark` | `string` | no | Note for the driver (sent to Maystro only; not sent to ZRExpress or Yalidine). |
| `orderId` | `string` | no | Your order reference. Yalidine requires one and generates `dzd-…` when absent. |

Unknown wilaya/commune names or ids → `NOT_FOUND` before the parcel is posted.

Output (`Parcel`):

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Carrier id (ZRExpress/Maystro UUID; Yalidine: the tracking number). Use it for `cancelParcel`. |
| `trackingNumber` | `string` | Tracking number to show to customers and pass to `track`. |
| `status` | `string` | Unified status (see [§4](#4-statuses)). |
| `provider` | `string` | `zrexpress` / `yalidine` / `maystro`. |
| `raw` | `mixed` | Native response (when `includeRaw`). |

> Maystro rejects an order with the same customer name + phone as another order created in the last 24 hours. Retrying after a timeout can therefore fail with `VALIDATION_ERROR` even though the first order was created.

### 3.2 `track(string $trackingNumber): TrackResult`

```php
$result = $client->track('yal-ABC123');

echo $result->parcel->status;               // current unified status
foreach ($result->events as $event) {        // oldest first
    echo "{$event->at}  {$event->status}  {$event->label}\n";
}
```

Output (`TrackResult`):

| Property | Type | Description |
|----------|------|-------------|
| `parcel` | `Parcel` | Current state (see above). |
| `events` | `TrackingEvent[]` | History, oldest first. May be empty. |

`TrackingEvent`:

| Property | Type | Description |
|----------|------|-------------|
| `status` | `string` | Unified status. |
| `label` | `string` | Native label, e.g. `Tentative échouée (Client ne répond pas)`. |
| `at` | `string` | ISO 8601 date with offset, e.g. `2025-12-30T13:24:34+01:00`. |
| `raw` | `mixed` | Native event. |

An unknown tracking number throws `NOT_FOUND`. Maystro throws `NOT_SUPPORTED`.

### 3.3 `getFees(FeeQuery|array $query): FeeQuote`

```php
$quote = $yalidine->getFees([
    'toWilayaId'  => 31,
    'toCommuneId' => 3101,   // prices are per commune on Yalidine and Maystro
    'weight'      => 2,
    'length'      => 50,     // cm: Yalidine bills the volumetric weight when it is higher
    'width'       => 40,
    'height'      => 30,
]);

echo $quote->deliveryFee;   // 950 when oversize_fee = 50 DA/kg (see below)
echo $quote->stopDeskFee;
echo $quote->returnFee;
```

Input (`FeeQuery`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `toWilayaId` | `int\|string` | **yes** | Code `1`–`58` or carrier id. |
| `toCommuneId` | `int\|string` | no | Yalidine/Maystro: without it, the first commune of the wilaya is used. |
| `fromWilayaId` | `int\|string` | no | Yalidine: overrides the client's `fromWilayaId`. |
| `weight` | `number` | no | kg. |
| `length`, `width`, `height` | `number` | no | cm. Used by Yalidine only. |
| `isStopDesk` | `bool` | no | `true`: `deliveryFee` is the stop-desk price. |

Output (`FeeQuote`):

| Property | Type | Description |
|----------|------|-------------|
| `deliveryFee` | `int\|float` | Price for the requested mode (home or stop desk). |
| `stopDeskFee` | `int\|float\|null` | Stop-desk price, when the carrier gives it. |
| `returnFee` | `int\|float\|null` | Return fee (Yalidine only today). |
| `currency` | `string` | Always `DZD`. |
| `raw` | `mixed` | Native response. |

**Yalidine overweight.** Billable weight = max(`weight`, `length × width × height × 0.0002`); the volumetric weight is only used when all three dimensions are given. Above 5 kg, `(billable − 5) × oversize_fee` (rounded up to the dinar) is added to both fees. In the example: 50 × 40 × 30 × 0.0002 = 12 kg → (12 − 5) × 50 = 350 DA, on top of a 600 DA home price.

ZRExpress and Maystro ignore weight and dimensions. No price for the requested mode → `NOT_FOUND`.

### 3.4 `getWilayas(): Location[]`

```php
foreach ($client->getWilayas() as $wilaya) {
    echo "{$wilaya->code} {$wilaya->name} ({$wilaya->id})\n";
}
```

### 3.5 `getCommunes(int|string $wilayaId): Location[]`

```php
$communes = $client->getCommunes(16);       // code, carrier id or (Yalidine/Maystro) name
```

Output (`Location`, for both methods):

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Carrier id: pass it as `wilayaId` / `communeId`. ZRExpress uses UUIDs; Yalidine and Maystro use numbers (wilaya id = official code). |
| `name` | `string` | Name (French/Latin). |
| `parentId` | `?string` | Communes: the wilaya id. |
| `code` | `?string` | Wilayas: official code `1`–`58`. Communes: postal code when known (Maystro). |
| `raw` | `mixed` | Native item. |

Undeliverable wilayas/communes are skipped. Results are cached for the lifetime of the client object, so reuse one client instead of creating one per request.

### 3.6 `getStopDesks(StopDeskQuery|array $query): array`

New. Lists the stop desks / pickup points where a parcel can be collected. Use the returned `id` as `stopDeskId` in `createParcel`.

```php
// ZRExpress: start with wilaya only — commune filter often returns no hubs.
$desks = $client->getStopDesks(['wilayaId' => 16]);

foreach ($desks as $desk) {
    echo "{$desk->id}  {$desk->name}  {$desk->address}\n";
}
```

Input (`StopDeskQuery`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `wilayaId` | `int\|string` | **yes** | Code `1`–`58`, carrier id or name. |
| `communeId` | `int\|string` | Maystro: **yes**; others: no | Carrier id or name. Optional filter for Yalidine / ZRExpress / Ecotrack. |

Output (`StopDesk[]`):

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Pass as `stopDeskId`. |
| `name` | `string` | Desk name. |
| `address` | `?string` | When the carrier gives it. |
| `communeId` | `?string` | Commune of the desk. |
| `wilayaId` | `?string` | Wilaya of the desk. |
| `phone` | `?string` | Primary phone when available. |
| `openingHours` | `?string` | Opening hours text when available. |
| `lat` / `lng` | `?float` | Coordinates when available. |
| `type` | `?string` | Carrier hub type (e.g. ZRExpress `"stopdesk"`). |
| `raw` | `mixed` | Native item. |

Carrier differences:

- **Yalidine**: Yalidine "centers". `communeId` is an optional filter.
- **Maystro**: `communeId` is required. The commune's own Maystro stop desk has the **commune id** as its `id`; partner pickup points have their pickup-point id.
- **ZRExpress**: [`POST /api/v1/hubs/search`](https://docs.zrexpress.app/reference/searchhubsendpoint) with `isPickupPoint = true`. Prefer **wilaya-only** listing; if `communeId` yields no desks but the wilaya has hubs, throws `NOT_FOUND` with `EMPTY_COMMUNE_HUBS`. Use the returned hub UUID as `stopDeskId`.

### 3.7 `cancelParcel(string $trackingNumberOrId): void`

```php
$client->cancelParcel($parcel->trackingNumber);
```

- **ZRExpress**: accepts the UUID or the tracking number.
- **Yalidine**: only parcels still in `En préparation` can be deleted; otherwise `VALIDATION_ERROR`.
- **Maystro**: `NOT_SUPPORTED`.

### 3.8 `healthCheck(): HealthCheckResult`

Lightweight authenticated probe (wilayas listing). **Always hits the network** (bypasses the in-memory cache). On success returns `{ ok: true, provider, latencyMs }`; on failure throws `ShippingError` (`AUTH_FAILED`, `NETWORK_ERROR`, …).

```php
$health = $client->healthCheck();
// $health->ok === true
// $health->provider  // 'yalidine' | ...
// $health->latencyMs // milliseconds
```

---

## 4. Statuses

Every carrier status is mapped to one of:

| Status | Meaning |
|--------|---------|
| `pending` | Registered but not yet confirmed / ready for pickup. |
| `created` | Confirmed, ready to be picked up or dispatched. |
| `in_transit` | Picked up and moving: hub, transfer, out for delivery, failed attempt… |
| `delivered` | Delivered (COD collected). |
| `returned` | Returned or being returned to the sender. |
| `cancelled` | Cancelled / deleted before delivery. |
| `unknown` | Not mapped yet. Never an error: check `$event->label` / `->raw`. |

Constants are in `DzDelivery\Models\ParcelStatus` (`ParcelStatus::DELIVERED`, …, `ParcelStatus::ALL`).

To map a native status yourself (e.g. from a webhook), use `DzDelivery\Support\StatusMapper`:

```php
use DzDelivery\Support\StatusMapper;

StatusMapper::map('yalidine', 'Sorti en livraison');  // 'in_transit'
StatusMapper::maystro(41);                             // 'delivered' (code or name)
```

The full native → unified tables are in [`PROVIDERS.md`](./PROVIDERS.md).

---

## 5. Error handling

Everything throws `DzDelivery\Errors\ShippingError` (extends `\RuntimeException`).

| Property | Type | Description |
|----------|------|-------------|
| `code` | `string` | One of the codes below (string, not an int). |
| `getMessage()` | `string` | Carrier message when available. |
| `httpStatus` | `?int` | HTTP status of the failed call. |
| `details` | `?array` | E.g. validation errors `[['field' => 'phone', 'message' => '…'], …]`. |
| `raw` | `mixed` | Native error body. |
| `provider` | `?string` | Carrier key. |
| `retryAfter` | `?int` | `RATE_LIMITED` only: seconds to wait, from the `Retry-After` header when sent. |

| Code | When |
|------|------|
| `AUTH_FAILED` | Missing/invalid credentials (401/403). |
| `VALIDATION_ERROR` | Bad input (checked before the call), 400/422, or the carrier rejected the parcel. |
| `NOT_FOUND` | 404, unknown parcel, wilaya or commune. |
| `RATE_LIMITED` | 429. Yalidine defaults: 5 req/s, 50/min, 1 000/h, 10 000/day. |
| `NOT_SUPPORTED` | The carrier has no such operation. |
| `PROVIDER_ERROR` | 5xx or unexpected response. |
| `NETWORK_ERROR` | Timeout, DNS, connection refused. |
| `UNKNOWN` | Anything else. |

The SDK never retries by itself. A simple retry for rate limits:

```php
use DzDelivery\Errors\ShippingError;

function withRetry(callable $call, int $attempts = 3): mixed
{
    for ($i = 1; ; $i++) {
        try {
            return $call();
        } catch (ShippingError $e) {
            if ($e->code !== ShippingError::RATE_LIMITED || $i >= $attempts) {
                throw $e;
            }
            sleep($e->retryAfter ?? 2 ** $i);
        }
    }
}

$wilayas = withRetry(fn () => $client->getWilayas());
```

Do **not** blindly retry `createParcel` on `NETWORK_ERROR`: the parcel may already exist. Check first, or rely on your `orderId`.

Showing validation errors to a user:

```php
try {
    $client->createParcel($input);
} catch (ShippingError $e) {
    if ($e->code === ShippingError::VALIDATION_ERROR) {
        foreach ($e->details ?? [] as $d) {
            $errors[$d['field'] ?? 'general'][] = $d['message'];
        }
    } else {
        error_log("[{$e->provider}] {$e->code}: {$e->getMessage()}");
        throw $e;
    }
}
```

---

## 6. Laravel example

`config/services.php`:

```php
'dz_delivery' => [
    'default' => env('DZ_DELIVERY_PROVIDER', 'yalidine'),
    'zrexpress' => ['apiKey' => env('ZREXPRESS_API_KEY'), 'tenant' => env('ZREXPRESS_TENANT')],
    'yalidine' => [
        'apiId' => env('YALIDINE_API_ID'),
        'apiToken' => env('YALIDINE_API_TOKEN'),
        'fromWilayaId' => (int) env('YALIDINE_FROM_WILAYA_ID', 16),
    ],
    'maystro' => ['apiToken' => env('MAYSTRO_API_TOKEN')],
],
```

`app/Providers/ShippingServiceProvider.php` (register it in `bootstrap/providers.php` or `config/app.php`):

```php
namespace App\Providers;

use DzDelivery\ClientFactory;
use DzDelivery\Contracts\ShippingProviderInterface;
use Illuminate\Support\ServiceProvider;

final class ShippingServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Default carrier, injectable anywhere. One instance per app = location caches are shared.
        $this->app->singleton(ShippingProviderInterface::class, function () {
            $provider = config('services.dz_delivery.default');

            return ClientFactory::create($provider, config("services.dz_delivery.$provider"));
        });
    }
}
```

Controller:

```php
use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;

final class ShipmentController
{
    public function store(Order $order, ShippingProviderInterface $shipping)
    {
        try {
            $parcel = $shipping->createParcel([
                'recipientName' => $order->customer_name,
                'phone' => $order->phone,
                'address' => $order->address,
                'wilayaId' => $order->wilaya_code,
                'communeName' => $order->commune,
                'productName' => $order->summary(),
                'price' => $order->total,
                'orderId' => (string) $order->id,
            ]);
        } catch (ShippingError $e) {
            return back()->withErrors(['shipping' => $e->getMessage()]);
        }

        $order->update(['tracking' => $parcel->trackingNumber, 'carrier' => $parcel->provider]);

        return back();
    }
}
```

Several carriers at once? Bind a small factory instead (e.g. `fn (string $p) => ClientFactory::create($p, config("services.dz_delivery.$p"))`) and keep one client per carrier.

---

## 7. Maystro webhooks

Maystro has no tracking endpoint: status changes are **pushed** to an HTTPS URL you configure in the Maystro web app (Settings → Webhooks). The event that matters is `OrderStatusChanged`, whose `payload` is `{ "id": "<order uuid>", "status": <numeric code> }`. `payload.id` is the order id returned as `$parcel->id` by `createParcel`.

What the Maystro docs say about the request body (we have not captured a real request yet, so treat this as unverified):

- the JSON event is base64-encoded and sent in `message.data`;
- the text says to decode it "twice using base64", while their Django example decodes it once. The example below handles both.

```php
<?php
// public/maystro-webhook.php

require __DIR__ . '/../vendor/autoload.php';

use DzDelivery\Support\StatusMapper;

$body = json_decode(file_get_contents('php://input') ?: '', true);
$data = $body['message']['data'] ?? null;

$event = null;
if (is_string($data)) {
    $decoded = base64_decode($data, true);
    $event = json_decode((string) $decoded, true);
    if (!is_array($event)) {                       // decoded once is still base64
        $event = json_decode((string) base64_decode((string) $decoded, true), true);
    }
}

if (!is_array($event)) {
    http_response_code(400);
    exit;
}

if (($event['event'] ?? null) === 'OrderStatusChanged') {
    $orderId = (string) ($event['payload']['id'] ?? '');
    $status = StatusMapper::maystro($event['payload']['status'] ?? null);  // e.g. 41 → 'delivered'

    // update your order where carrier_id = $orderId ...
}

http_response_code(201);
```

The docs describe no signature for webhook requests. Protect the endpoint yourself, e.g. with a long secret in the URL (`/maystro-webhook.php?key=…`) that you check before processing.

---

## 8. Testing your integration

Pass a Guzzle handler through the `handler` option to replace the network with canned responses:

```php
use DzDelivery\ClientFactory;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;

$mock = new MockHandler([
    new Response(200, ['Content-Type' => 'application/json'], json_encode([
        'has_more' => false,
        'data' => [['id' => 16, 'name' => 'Alger', 'zone' => 1, 'is_deliverable' => 1]],
    ])),
]);

$client = ClientFactory::create('yalidine', [
    'apiId' => 'test', 'apiToken' => 'test', 'fromWilayaId' => 16,
    'handler' => HandlerStack::create($mock),
]);

$wilayas = $client->getWilayas();   // served by the mock, no HTTP call
```

Add `GuzzleHttp\Middleware::history($container)` to the stack to assert on the requests sent. Realistic native responses for every carrier are in [`docs/fixtures/`](./fixtures/).

In application code, type-hint `ShippingProviderInterface`: you can then swap in your own fake implementation in tests instead of mocking HTTP.
