# dz-delivery — Shared Contract (v0.1)

> **This document is the source of truth.** The TypeScript (`packages/ts`) and PHP (`packages/php`) packages MUST implement exactly these models, method names, field names and statuses.
> A field that is not in this document is not added "just for one provider" without an issue and a discussion. Provider-specific data goes in `raw`.

Keywords **MUST**, **SHOULD**, **MAY** are used as in RFC 2119.

---

## 1. Conventions

| Topic | Rule |
|-------|------|
| Naming | `camelCase` for fields and methods in **both** TS and PHP (PHP objects expose public readonly properties with the same names). |
| IDs | All IDs returned by the SDK are **strings** (carriers use UUIDs, integers, or codes). Inputs MAY accept `string \| int`. |
| Money | Amounts are in **DZD**, as numbers (dinars, not centimes). `currency` is always `"DZD"`. |
| Weight / size | Weight in **kg**, dimensions in **cm**. |
| Dates | ISO 8601 strings with timezone (e.g. `2025-12-23T15:23:54+00:00`) in both TS and PHP. |
| Phones | Strings. Providers normalize to the carrier's format (e.g. `0550123456` ↔ `+213550123456`). |
| Optional | `?` = optional. Absent optional values are `undefined` (TS) / `null` (PHP). |
| Async | TS methods return `Promise<T>`. PHP methods are synchronous and return `T`. |
| Errors | All failures are thrown as `ShippingError` (see §3). Never return `null`/`false` to signal an error. |

### The `raw` rule

Every returned model (`Parcel`, `TrackingEvent`, `FeeQuote`, `Location`, `ShippingError`) MAY carry an optional `raw` field containing the **unmodified native API response** (or the relevant fragment).

- `raw` is for power users and debugging. Its shape is **not** part of the contract and may change when the carrier changes its API.
- Application code SHOULD NOT depend on `raw` for core logic.
- Providers SHOULD populate `raw` by default. A client option `includeRaw: false` MAY disable it.

---

## 2. Models

### 2.1 `ParcelInput`

Input to `createParcel`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recipientName` | `string` | **yes** | Full name of the recipient. |
| `phone` | `string` | **yes** | Primary phone number. |
| `phone2` | `string` | no | Secondary phone number. |
| `address` | `string` | **yes** | Street address / free text. |
| `wilayaId` | `string \| int` | one of¹ | Provider `Location.id` **or** official wilaya code `1`–`58`. |
| `wilayaName` | `string` | one of¹ | Wilaya name (resolved by the provider, case/accent-insensitive). |
| `communeId` | `string \| int` | one of² | Provider `Location.id` of the commune. |
| `communeName` | `string` | one of² | Commune name (resolved within the wilaya). |
| `productName` | `string` | one of³ | Single free-text product description. |
| `productList` | `ProductItem[]` | one of³ | Detailed list of products. |
| `price` | `number` | **yes** | Amount to collect from the recipient (COD), in DZD. `0` for prepaid. |
| `weight` | `number` | no | Total weight in kg. |
| `length` | `number` | no | Package length in cm. |
| `width` | `number` | no | Package width in cm. |
| `height` | `number` | no | Package height in cm. |
| `isStopDesk` | `boolean` | no | `true` = delivery to a stop desk / pickup point. Default `false` (home delivery). |
| `stopDeskId` | `string` | if `isStopDesk` | Provider ID of the stop desk / hub. |
| `remark` | `string` | no | Note for the delivery agent. |
| `orderId` | `string` | no | Merchant's own order reference (stored as external ID when supported). |
| `stockType` | `"none" \| "local" \| "warehouse"` | no | Default stock mode for products that omit `ProductItem.stockType`. Used by ZRExpress (`orderedProducts[].stockType`); ignored by other MVP carriers. SDK default when omitted: `"none"` (no catalog). |

¹ Exactly one of `wilayaId` / `wilayaName` is required.
² Exactly one of `communeId` / `communeName` is required.
³ Exactly one of `productName` / `productList` is required. Providers that need a list convert `productName` to `[{ name, quantity: 1, unitPrice: price }]`; providers that need a string join `productList` names.

Whether `price` includes the delivery fee is carrier-dependent; providers MUST document it in `docs/PROVIDERS.md`.

#### `ProductItem`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | **yes** | Product name. |
| `quantity` | `int` | **yes** | Quantity (≥ 1). |
| `unitPrice` | `number` | no | Unit price in DZD. |
| `sku` | `string` | no | Merchant SKU. |
| `productId` | `string` | no | Carrier catalog product id (ZRExpress when `stockType` is `local` / `warehouse`). |
| `stockType` | `"none" \| "local" \| "warehouse"` | no | Per-item stock mode. Overrides `ParcelInput.stockType` when set. Carriers that ignore stock omit it. |

### 2.2 `Parcel`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Carrier's internal parcel ID (may equal `trackingNumber` for some carriers). |
| `trackingNumber` | `string` | **yes** | Tracking number shown to customers. |
| `status` | `ParcelStatus` | **yes** | Unified status (see §4). |
| `provider` | `string` | **yes** | Provider key, e.g. `"zrexpress"`, `"yalidine"`. |
| `raw` | `unknown` / `mixed` | no | Native response. |

### 2.3 `TrackingEvent`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `ParcelStatus` | **yes** | Unified status after this event. |
| `label` | `string` | **yes** | Human-readable native label (e.g. `"Prêt à expédier"`). |
| `at` | `string` | **yes** | ISO 8601 timestamp of the event. |
| `raw` | `unknown` / `mixed` | no | Native event. |

Events are returned **sorted by `at` ascending** (oldest first).

### 2.4 `TrackResult`

| Field | Type | Description |
|-------|------|-------------|
| `parcel` | `Parcel` | Current state of the parcel. |
| `events` | `TrackingEvent[]` | History, oldest first. MAY be empty if the carrier exposes no history. |

### 2.5 `FeeQuery`

Input to `getFees`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `toWilayaId` | `string \| int` | **yes** | Destination wilaya (provider `Location.id` or code `1`–`58`). |
| `toCommuneId` | `string \| int` | no | Destination commune, for carriers that price per commune. |
| `fromWilayaId` | `string \| int` | no | Origin wilaya. Defaults to the account's origin when the carrier knows it. |
| `weight` | `number` | no | Weight in kg (for overweight surcharges). |
| `length`, `width`, `height` | `number` | no | Package dimensions in cm, for carriers that bill volumetric weight. |
| `isStopDesk` | `boolean` | no | Quote for stop-desk delivery instead of home delivery. |

### 2.6 `FeeQuote`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deliveryFee` | `number` | **yes** | Fee for the requested mode (home, or stop desk if `isStopDesk: true`). |
| `returnFee` | `number` | no | Fee charged if the parcel is returned. |
| `stopDeskFee` | `number` | no | Stop-desk fee, when the carrier returns both prices. |
| `currency` | `"DZD"` | **yes** | Always `"DZD"`. |
| `raw` | `unknown` / `mixed` | no | Native response. |

### 2.7 `Location`

Used for both wilayas and communes.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Provider ID — pass this back as `wilayaId` / `communeId`. |
| `name` | `string` | **yes** | Display name. |
| `parentId` | `string` | no | For communes: the wilaya `id`. Absent for wilayas. |
| `code` | `string` | no | Official code when known (wilaya `"1"`–`"58"`, or postal code for communes). |
| `raw` | `unknown` / `mixed` | no | Native object. |

> **Decision:** `code` was added on top of `id`/`name`/`parentId` because some carriers (e.g. ZRExpress) use UUIDs as IDs. `code` lets apps match wilayas across providers.

### 2.8 `ShippingError`

Thrown (TS: `class ShippingError extends Error`; PHP: `class ShippingError extends \RuntimeException`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | `ShippingErrorCode` | **yes** | Normalized code (see §3). |
| `message` | `string` | **yes** | Human-readable message (native message when available). |
| `httpStatus` | `int` | no | HTTP status of the failed call. |
| `details` | `object` / `array` | no | Normalized details, e.g. validation errors `[{ field?, message }]`. |
| `raw` | `unknown` / `mixed` | no | Native error body. |
| `provider` | `string` | no | Provider key that raised the error. |
| `retryAfter` | `int` | no | `RATE_LIMITED` only: seconds to wait, from the `Retry-After` header when the carrier sends it. |

### 2.9 `StopDeskQuery`

Input to `getStopDesks`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wilayaId` | `string \| int` | **yes** | Wilaya (provider `Location.id`, code `1`–`58`, or name). |
| `communeId` | `string \| int` | no | Commune (provider `Location.id` or name). Some carriers require it (Maystro). Optional filter elsewhere — prefer wilaya-only when unsure (see carrier notes in `PROVIDERS.md`). |

### 2.10 `StopDesk`

A stop desk / pickup point where the recipient collects the parcel.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Pass this back as `ParcelInput.stopDeskId`. |
| `name` | `string` | **yes** | Display name. |
| `address` | `string` | no | Street address, when the carrier returns it. |
| `communeId` | `string` | no | Provider commune id. |
| `wilayaId` | `string` | no | Provider wilaya id. |
| `phone` | `string` | no | Primary phone, when the carrier returns it. |
| `openingHours` | `string` | no | Opening hours text, when available. |
| `lat` | `number` | no | Latitude. |
| `lng` | `number` | no | Longitude. |
| `type` | `string` | no | Carrier hub/desk type label when exposed (e.g. ZRExpress `"stopdesk"`). |
| `raw` | `unknown` / `mixed` | no | Native object. |

### 2.11 `ParcelListQuery`

Input to `listParcels` (paginated account sync).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `page` | `int` | no | 1-based page. Default `1`. |
| `pageSize` | `int` | no | Page size. Default `50`. Carriers MAY clamp (ZRExpress ≤ 1000). |
| `keyword` | `string` | no | Free-text search (tracking, customer name, phone… when the carrier supports it). |
| `orderId` | `string` | no | Merchant order reference (`ParcelInput.orderId` / carrier external id). |
| `status` | `ParcelStatus` | no | Unified status filter. Applied after mapping when the carrier has no unified filter (typical). |
| `updatedSince` | `string` | no | ISO 8601 — only parcels whose status changed at/after this instant (when the carrier exposes an update timestamp). |
| `allPages` | `boolean` | no | When `true`, follow `hasNext` and merge pages (subject to a safety cap). Default `false`. |

### 2.12 `ParcelListPage`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parcels` | `Parcel[]` | **yes** | Mapped parcels for this response (or all pages when `allPages`). |
| `page` | `int` | **yes** | Page that was fetched (or `1` when `allPages` merged everything). |
| `pageSize` | `int` | **yes** | Requested/effective page size. |
| `totalCount` | `int` | **yes** | Carrier-reported total matching the query (before client-side `status` filter when applicable). |
| `hasNext` | `boolean` | **yes** | More pages available (`false` when `allPages` finished or carrier has no more). |
| `raw` | `unknown` / `mixed` | no | Native page payload (last page when `allPages`). |

---

## 3. Error codes

| `code` | When |
|--------|------|
| `AUTH_FAILED` | 401/403, missing or invalid credentials. |
| `VALIDATION_ERROR` | 400/422, or SDK-side input validation failure (before any HTTP call). |
| `NOT_FOUND` | 404, parcel / location not found, or name resolution (`wilayaName`, `communeName`) failed. |
| `RATE_LIMITED` | 429. |
| `NOT_SUPPORTED` | The carrier does not support this operation (e.g. cancellation). |
| `PROVIDER_ERROR` | 5xx or an unexpected/unparseable carrier response. |
| `NETWORK_ERROR` | Timeout, DNS, connection refused. |
| `UNKNOWN` | Anything else. |

Default HTTP → code mapping: `400, 422 → VALIDATION_ERROR`, `401, 403 → AUTH_FAILED`, `404 → NOT_FOUND`, `429 → RATE_LIMITED`, `5xx → PROVIDER_ERROR`, other `4xx → UNKNOWN`.

---

## 4. Unified statuses

```
pending | created | in_transit | delivered | returned | cancelled | unknown
```

| Status | Meaning |
|--------|---------|
| `pending` | Order registered but not yet confirmed / ready for pickup (draft, "order received"). |
| `created` | Confirmed and ready to be picked up or dispatched by the carrier. |
| `in_transit` | Picked up and moving: in hub, in transfer, out for delivery, failed attempt, etc. |
| `delivered` | Delivered to the recipient (COD collected). |
| `returned` | Returned or being returned to the sender. |
| `cancelled` | Cancelled / deleted before delivery. |
| `unknown` | Native status not mapped. **Never throw** on an unknown native status — return `unknown` and keep the native label in `TrackingEvent.label` / `raw`. |

Each provider's native → unified table lives in `docs/PROVIDERS.md` and MUST be identical in TS and PHP (enforced by shared fixtures in `docs/fixtures/`).

---

## 5. `ShippingProvider` interface

Five MVP operations (locations is split in two methods), plus `getStopDesks`, `listParcels`, and `healthCheck`:

| # | Method | Input | Output |
|---|--------|-------|--------|
| 1 | `createParcel(input)` | `ParcelInput` | `Parcel` |
| 2 | `track(trackingNumber)` | `string` | `TrackResult` = `{ parcel, events }` |
| 3 | `getFees(query)` | `FeeQuery` | `FeeQuote` |
| 4a | `getWilayas()` | — | `Location[]` |
| 4b | `getCommunes(wilayaId)` | `string \| int` (provider id or code 1–58) | `Location[]` |
| 5 | `cancelParcel(trackingNumberOrId)` | `string` | `void` |
| 6 | `getStopDesks(query)` | `StopDeskQuery` | `StopDesk[]` |
| 7 | `listParcels(query?)` | `ParcelListQuery` | `ParcelListPage` |
| 8 | `healthCheck()` | — | `HealthCheckResult` = `{ ok: true, provider, latencyMs }` |

### TypeScript reference

```ts
export type ParcelStatus =
  | 'pending' | 'created' | 'in_transit' | 'delivered'
  | 'returned' | 'cancelled' | 'unknown';

export interface HealthCheckResult {
  ok: true;
  provider: string;
  /** Round-trip duration in milliseconds. */
  latencyMs: number;
}

export interface ShippingProvider {
  readonly name: string; // 'zrexpress' | 'yalidine' | ...
  createParcel(input: ParcelInput): Promise<Parcel>;
  track(trackingNumber: string): Promise<TrackResult>;
  getFees(query: FeeQuery): Promise<FeeQuote>;
  getWilayas(): Promise<Location[]>;
  getCommunes(wilayaId: string | number): Promise<Location[]>;
  getStopDesks(query: StopDeskQuery): Promise<StopDesk[]>;
  listParcels(query?: ParcelListQuery): Promise<ParcelListPage>;
  cancelParcel(trackingNumberOrId: string): Promise<void>;
  healthCheck(): Promise<HealthCheckResult>;
}
```

### PHP reference

```php
namespace DzDelivery\Contracts;

interface ShippingProviderInterface
{
    public function getName(): string;
    public function createParcel(ParcelInput|array $input): Parcel;
    public function track(string $trackingNumber): TrackResult;
    public function getFees(FeeQuery|array $query): FeeQuote;
    /** @return Location[] */
    public function getWilayas(): array;
    /** @return Location[] */
    public function getCommunes(string|int $wilayaId): array;
    /** @return StopDesk[] */
    public function getStopDesks(StopDeskQuery|array $query): array;
    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage;
    public function cancelParcel(string $trackingNumberOrId): void;
    public function healthCheck(): HealthCheckResult;
}
```

### Method rules

1. **`createParcel`** — Validates required fields client-side (throws `VALIDATION_ERROR` before any HTTP call). Resolves `wilayaName` / `communeName` / wilaya codes to provider IDs when needed. If the carrier only returns an ID on creation, the provider MAY perform a follow-up read to fill `trackingNumber` and `status`.
2. **`track`** — Returns the current `Parcel` plus history. If the carrier needs an internal ID for history, the provider resolves it from the tracking number.
3. **`getFees`** — Returns a single quote for the requested destination/mode. Throws `NOT_FOUND` if the destination has no rate.
4. **`getWilayas` / `getCommunes`** — Return only deliverable locations when the carrier exposes that information. Implementations MAY cache results in memory for the client's lifetime.
5. **`cancelParcel`** — Accepts a tracking number or an internal ID. Resolves to the identifier the carrier needs. Throws `NOT_SUPPORTED` if the carrier cannot cancel, or `VALIDATION_ERROR` / `PROVIDER_ERROR` if the parcel is past the cancellable state.

6. **`getStopDesks`** — Lists the stop desks / pickup points of a wilaya (optionally one commune). Throws `VALIDATION_ERROR` when a carrier needs `communeId` and it is missing, `NOT_SUPPORTED` when the carrier exposes no listing. Carriers MAY throw `NOT_FOUND` with an actionable `details` hint when a commune filter yields no desks but the wilaya still has desks (typical for ZRExpress hubs keyed at wilaya level).

7. **`listParcels`** — Lists parcels for the authenticated account (paginated), with current unified `status` on each `Parcel`. Does **not** include full `TrackingEvent` history — call `track()` for history. Throws `NOT_SUPPORTED` when the carrier exposes no listing (use webhooks / per-tracking `track` instead). Prefer webhooks over aggressive polling when available.

8. **`healthCheck`** — Probes credentials and connectivity with a lightweight authenticated request (the carrier's wilayas listing). **Always hits the network** (bypasses the in-memory wilayas cache). On success returns `{ ok: true, provider, latencyMs }`. On failure throws `ShippingError` (`AUTH_FAILED`, `NETWORK_ERROR`, `RATE_LIMITED`, …) like any other method. Never throws `NOT_SUPPORTED`.

> **Decision:** `cancelParcel` returns `void` (not `Parcel`) because some carriers answer with `204 No Content`. Call `track()` afterwards if you need the new status.

---

## 6. Client construction

```ts
// TS
const client = createClient('zrexpress', { apiKey, tenant, /* baseUrl?, timeoutMs?, includeRaw? */ });
```

```php
// PHP
$client = ClientFactory::create('zrexpress', ['apiKey' => ..., 'tenant' => ..., /* 'baseUrl', 'timeoutMs', 'includeRaw' */]);
```

| Common option | Type | Default | Description |
|---------------|------|---------|-------------|
| `baseUrl` | `string` | provider default | Override API base URL (sandbox, proxy, tests). |
| `timeoutMs` | `int` | `15000` | HTTP timeout. |
| `includeRaw` | `boolean` | `true` | Populate `raw` fields. |

Provider-specific credentials:

| Provider | Config keys | Env vars (`.env.example`) |
|----------|-------------|---------------------------|
| `zrexpress` | `apiKey`, `tenant` | `ZREXPRESS_API_KEY`, `ZREXPRESS_TENANT` |
| `yalidine` | `apiId`, `apiToken` | `YALIDINE_API_ID`, `YALIDINE_API_TOKEN` |
| `maystro` | `apiToken` | `MAYSTRO_API_TOKEN` |

---

## 7. Out of MVP scope

The following are **intentionally not** part of the unified `ShippingProvider` contract (see Phase 6 in `TASKS.md`):

- Catalog endpoints (ZRExpress *create product*, categories, stock, receipts)
- Parcel updates (address, amount, products), exchanges, refunds
- Pickup bags
- Claims, customers, treasury / payments, reports
- Webhooks **endpoint management** (CRUD)

They MAY be added later as **optional, provider-specific modules** that do not change the `ShippingProvider` interface.

### Provider-specific extras (not the unified contract)

Some carriers expose richer native APIs. Those MAY ship as **extras on the concrete provider class** (e.g. `ZRExpressProvider`) and standalone helpers, without extending `ShippingProvider` / `ShippingProviderInterface`.

For ZRExpress (see [`ZREXPRESS.md`](./ZREXPRESS.md)):

| Extra | Surface | Notes |
|-------|---------|-------|
| Bulk create / bulk delete | `ZRExpressProvider.createParcelsBulk` / `deleteParcelsBulk` | Not on the unified interface |
| Labels (HTML URL) | `ZRExpressProvider.generateLabels` | Not on the unified interface |
| Webhooks **receive** (verify + parse) | `verifyZRExpressWebhook` / PHP `Webhook::verify` | Helpers only; raw body required |

`listParcels` remains the pull alternative for status sync; prefer webhooks in production when available.

---

## 8. Versioning

This contract is versioned (`v0.1`). Breaking changes to models or the interface require a version bump here and a matching release of both packages.
