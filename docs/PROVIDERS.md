# Provider mapping

How each carrier's native API maps to the unified [`ShippingProvider`](./CONTRACT.md#5-shippingprovider-interface) methods.
TS and PHP implementations MUST follow these tables. Update this file **before** changing a provider's behavior.

| Provider | Key | Status |
|----------|-----|--------|
| ZRExpress | `zrexpress` | mapping drafted, implemented in PHP and TS — extras: [`ZREXPRESS.md`](./ZREXPRESS.md) |
| Yalidine | `yalidine` | mapping checked against the developer docs (2026-10-20), implemented in PHP and TS |
| Maystro Delivery | `maystro` | built from the public API docs (2026-10-20), implemented in PHP and TS; `track` / `cancelParcel` not supported |
| Ecotrack (DHD, Anderson, World Express, 48Hr, …) | `ecotrack` | Postman notes + Delivery tenant hosts (2026-10-20); one provider, tenant via `courier` / `baseUrl` |
| Ecom (ecom-dz.net) | `ecom` | **out of MVP / backlog** — see [below](#ecom-out-of-mvp--backlog); legacy app company-id `19` (`Delivery/EcomDelivery.php`) |

---

## ZRExpress

Official docs (source of truth for native paths):

| | URL |
|--|-----|
| API reference index | <https://docs.zrexpress.app/reference> |
| Guides (auth, webhooks, search body) | <https://docs.zrexpress.app/docs> · [Authentication](https://docs.zrexpress.app/docs/authentication) · [How to use search endpoints](https://docs.zrexpress.app/docs) |
| Machine-readable index | <https://docs.zrexpress.app/llms.txt> |

- Base URL: `https://api.zrexpress.app`
- API version: path segment `/api/v1/...` (OpenAPI uses `/api/v{version}/…` with default `1`).

### Auth

Every request sends ([Authentication guide](https://docs.zrexpress.app/docs/authentication)):

| Header | Value | Config key |
|--------|-------|------------|
| `X-Api-Key` | Secret API key from the portal | `apiKey` (`ZREXPRESS_API_KEY`) |
| `X-Tenant` | Tenant ID | `tenant` (`ZREXPRESS_TENANT`) |
| `Accept` / `Content-Type` | `application/json` | — |

### Method mapping

| Unified method | Native endpoint | Official doc | Notes |
|----------------|-----------------|--------------|-------|
| `createParcel` | `POST /api/v1/parcels` | [Creates a parcel](https://docs.zrexpress.app/reference/createparcelendpoint) | Returns `201 { id }` only → follow up with [get by id](https://docs.zrexpress.app/reference/getparcelbyidsupplierendpoint) to fill `trackingNumber` and `status`. `StockType`: `local` \| `warehouse` \| `none` — SDK defaults to `none` (no catalog); set `ParcelInput.stockType` / `ProductItem.stockType` to override (`local`/`warehouse` require `productId` + `sku`). `DeliveryType`: `home` \| `pickup-point`. |
| `track` | `GET /api/v1/parcels/{idOrTracking}` + `…/state-history` | [Get by id](https://docs.zrexpress.app/reference/getparcelbyidsupplierendpoint) · [Get by trackingNumber](https://docs.zrexpress.app/reference/getparcelbytrackingnumbersupplierendpoint) · [State history](https://docs.zrexpress.app/reference/getparcelstatehistorysupplierendpoint) | Native path is the same for UUID and tracking number (`/parcels/{x}`). First call fills `Parcel`; second builds the event list. Prefer webhooks over polling when possible ([Webhooks vs Polling](https://docs.zrexpress.app/docs/webhooks-vs-polling-a-comparison)). |
| `getFees` | `GET /api/v1/delivery-pricing/rates/{toTerritoryId}` | [Rate for a territory](https://docs.zrexpress.app/reference/getrateendpoint) · [All rates](https://docs.zrexpress.app/reference/getallratesendpoint) | Pick the `deliveryPrices[]` entry matching `deliveryType` (`home` / `pickup-point`). Supplier-specific prices override price-list prices. |
| `getWilayas` | `POST /api/v1/territories/search` | [Search territories](https://docs.zrexpress.app/reference/searchterritoriesendpoint) | Filter `level = "wilaya"`. Paginated (`pageSize` ≤ 1000); loop while `hasNext`. Body shape: see [search endpoints guide](https://docs.zrexpress.app/docs). Territories with both `delivery.hasHomeDelivery` and `delivery.hasPickupPoint` false are skipped. |
| `getCommunes` | `POST /api/v1/territories/search` | [Search territories](https://docs.zrexpress.app/reference/searchterritoriesendpoint) | Filter `level = "commune"` and `parentId = <wilaya id>`. |
| `getStopDesks` | `POST /api/v1/hubs/search` | [Search hubs](https://docs.zrexpress.app/reference/searchhubsendpoint) · [Get hub by id](https://docs.zrexpress.app/reference/gethubendpoint) | Filter `isPickupPoint = true` and `address.cityTerritoryId` (wilaya UUID); optional `address.districtTerritoryId` when `communeId` is set. **Prefer wilaya-only**: many hubs are not tagged with a district, so a commune filter often returns nothing even when the wilaya has desks — in that case the SDK throws `NOT_FOUND` (`details[].code = EMPTY_COMMUNE_HUBS`) asking to retry without `communeId`. Paginated (`pageSize` ≤ 1000). Hub `id` → `StopDesk.id` / `ParcelInput.stopDeskId` (`hubId` on create); `address.street` → `address`; `districtTerritoryId` → `communeId`; `cityTerritoryId` → `wilayaId`; also maps `phone.number1` → `phone`, `openingHours`, `address.coordinates.lat/lng`, `type`. Hubs with `isPickupPoint: false` are skipped client-side. |
| `listParcels` | `POST /api/v1/parcels/search` | [Search supplier parcels](https://docs.zrexpress.app/reference/searchsupplierparcelsendpoint) | Paginated (`pageSize` ≤ 1000, default 50). Maps each item → `Parcel` (`state.name` → unified status). `keyword` → body `keyword`; `orderId` → filter `externalId`; `updatedSince` → filter `lastStateUpdateAt` `gte`; `status` filtered client-side after mapping; `allPages: true` follows `hasNext` (cap 100 pages). No event history — use `track()`. |
| `cancelParcel` | `DELETE /api/v1/parcels/{id}` | [Delete a parcel](https://docs.zrexpress.app/reference/deleteparcelendpoint) | Requires the parcel **UUID**. If given a tracking number, resolve it first. |
| `healthCheck` | `POST /api/v1/territories/search` (wilayas) | [Search territories](https://docs.zrexpress.app/reference/searchterritoriesendpoint) | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

**ZRExpress extras** (on `ZRExpressProvider` + helpers, **not** on `ShippingProvider`): bulk create/delete, labels, webhook verify/parse — full matrix in [`ZREXPRESS.md`](./ZREXPRESS.md).

**Still out of MVP / backlog**: catalog ([create product](https://docs.zrexpress.app/reference/createproductendpoint), categories, stock), exchanges/refunds, pickup bags, claims, treasury, webhook endpoint CRUD. Prefer [webhooks](https://docs.zrexpress.app/docs/webhooks) for live status push; `listParcels` is the pull alternative. See `CONTRACT.md` §7.

### `ParcelInput` → `POST /parcels` body

| Unified field | ZRExpress field | Notes |
|---------------|-----------------|-------|
| `recipientName` | `customer.name` | 2–100 chars. |
| `phone` | `customer.phone.number1` | International format required → normalize `0XXXXXXXXX` to `+213XXXXXXXXX`. |
| `phone2` | `customer.phone.number2` | Same normalization. |
| — | `customer.customerId` | Required; send a random UUID v4 (no customer linking in MVP). |
| `address` | `deliveryAddress.street` | |
| `wilayaId` / `wilayaName` | `deliveryAddress.cityTerritoryId` | UUID. Resolve code `1`–`58` or name via territories search. A UUID is passed through without lookup. |
| `communeId` / `communeName` | `deliveryAddress.districtTerritoryId` | UUID. Resolve name (or postal code) via territories search within the wilaya. A UUID is passed through without lookup. |
| `productName` / `productList` | `orderedProducts[]` (`productName`, `quantity`, `unitPrice`, `productSku`, `productId`, `stockType`) | Default `stockType: "none"`. Override via `ParcelInput.stockType` or per-item `ProductItem.stockType`. `local` / `warehouse` require `productId` + `sku` (ZR catalog). `productName` → one item, `quantity: 1`, `unitPrice: price`. |
| `stockType` | `orderedProducts[].stockType` | `"none"` (default) \| `"local"` \| `"warehouse"`. ZR rule: products must be all `warehouse`, or a mix of `local` and `none`. |
| `productName` / joined names (+ `remark`) | `description` | Required, 2–250 chars. When `remark` is set, appended as `" - {remark}"` (then truncated to 250). |
| `price` | `amount` | ≤ 150 000 DZD, **includes delivery fee**. |
| `weight` | `weight.weight` | kg. |
| `length` / `width` / `height` | `orderedProducts[0].length/width/height` | No parcel-level dimensions; applied to the first item. |
| `isStopDesk` | `deliveryType` | `false` → `"home"`, `true` → `"pickup-point"`. |
| `stopDeskId` | `hubId` | Required when `deliveryType = "pickup-point"`. |
| `remark` | → `description` suffix | No dedicated native field; appended to `description` as `" - {remark}"`. |
| `orderId` | `externalId` | Max 100 chars, must be unique. |

> ⚠️ Without `stateId`, parcels are created in state `OrderReceived` / `commande_recue` and must later be moved to `ReadyToDispatch` before the hub accepts them. MVP: leave default (unified status `pending`). TODO: decide whether to expose a `readyToDispatch` option.

### Response → `Parcel`

| Unified | ZRExpress |
|---------|-----------|
| `id` | `id` (UUID) |
| `trackingNumber` | `trackingNumber` (e.g. `DZ-AL-20251121-00145`) |
| `status` | `state.name` → mapped (table below) |
| `provider` | `"zrexpress"` |

### State history → `TrackingEvent`

| Unified | ZRExpress (`state-history[]`) |
|---------|-------------------------------|
| `status` | `newState.name` → mapped |
| `label` | `newState.description` (fallback `newState.name`) |
| `at` | `createdAt` |

### Territory → `Location`

| Unified | ZRExpress |
|---------|-----------|
| `id` | `id` (UUID) |
| `name` | `name` |
| `parentId` | `parentId` |
| `code` | `code` (wilaya number) as string; for communes, `postalCode` when `code` is absent |

### Rate → `FeeQuote`

| Unified | ZRExpress |
|---------|-----------|
| `deliveryFee` | `deliveryPrices[deliveryType = home \| pickup-point].price` |
| `stopDeskFee` | `deliveryPrices[deliveryType = pickup-point].price` |
| `returnFee` | TODO — not exposed by the rates endpoint as far as we know |
| `currency` | `"DZD"` |

### Status mapping (draft — to complete with real fixtures)

The docs show both slug-style (`commande_recue`) and PascalCase (`OutForDelivery`) state names. Match **case-insensitively** on both forms.

| Native state (examples) | Unified |
|-------------------------|---------|
| `commande_recue`, `OrderReceived` | `pending` |
| `pret_a_expedier`, `ReadyToDispatch` | `created` |
| `confirme_au_bureau`, `OutForDelivery`, other hub / transfer states | `in_transit` |
| `Delivered` / `livre` / `encaisse` | `delivered` |
| `Returned` / `retour*` | `returned` |
| `Cancelled` / `annule` / `supprimee` | `cancelled` |
| anything else | `unknown` |

Implementation detail: names are compared after lowercasing, stripping accents and removing `_`, `-`, spaces. Order: exact pending/created/delivered/cancelled names → `returned` if it starts with `return`/`retour` → `in_transit` if it contains a transit keyword (`outfordelivery`, `transit`, `hub`, `transfer`, `dispatched`, `expedie`, `pickedup`, `attempt`, `echec`, `failed`, …) → `unknown`. Reference cases: [`fixtures/zrexpress/statuses.json`](./fixtures/zrexpress/statuses.json).

`TrackingEvent.at` is normalized to ISO 8601 with second precision and an explicit offset (`2025-12-23T15:23:54.2173951+00:00` → `2025-12-23T15:23:54+00:00`, `…Z` → `…+00:00`).

### Errors

ZRExpress returns RFC 7807 problem details:

```json
{ "type": "...", "title": "General.Validation", "status": 400, "detail": "...", "errors": [{ "code": "...", "description": "..." }], "traceId": "..." }
```

- `ShippingError.message` ← `detail` (fallback `title`)
- `ShippingError.details` ← `errors[]` mapped to `{ message: description, code }`
- `ShippingError.httpStatus` ← `status`
- HTTP status → `code` per the default table in `CONTRACT.md` §3.

---

## Yalidine

> Checked against the official developer docs (login required) on 2026-10-20, and against the in-repo `Delivery/YalidineController.php` + `Delivery/GuepExController.php` reference (same API platform). Error bodies are not documented and remain best-effort; contributions with anonymized real responses welcome.

- Docs: <https://yalidine.app/app/dev/docs/api/> (account required)
- Base URL: `https://api.yalidine.app/v1/` (paths below are relative to it; keep the trailing `/` on collection endpoints)

### GuepEx (same platform)

GuepEx runs the same Yalidine API under a different host. Use the **`yalidine`** provider with credentials from the GuepEx dashboard and:

| | |
|--|--|
| TS | `baseUrl: GUEPEX_DEFAULT_BASE_URL` (`https://api.guepex.app/v1`) |
| PHP | `'baseUrl' => YalidineProvider::GUEPEX_DEFAULT_BASE_URL` (`https://api.guepex.app/v1/`) |

Auth headers, endpoints, status mapping, and parcel fields are identical. GuepEx-only extras in the Delivery app (`economic` tier on create, client fee adjustment) are **not** in the shared `ParcelInput` contract — leave them as remaining / app-level.

### Auth

| Header | Value | Config key |
|--------|-------|------------|
| `X-API-ID` | API ID | `apiId` (`YALIDINE_API_ID`) |
| `X-API-TOKEN` | API token | `apiToken` (`YALIDINE_API_TOKEN`) |

Extra client option: **`fromWilayaId`** (code `1`–`58`) or **`fromWilayaName`** — the merchant's origin wilaya. Yalidine requires it to create parcels (`from_wilaya_name`) and to quote fees (`from_wilaya_id`). `getFees` uses `FeeQuery.fromWilayaId` first, then this option; otherwise `VALIDATION_ERROR`.

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST parcels/` | Body is an **array** of parcels (we send one). Response is an object keyed by `order_id`: `{ "<order_id>": { success, order_id, tracking, import_id, label, message } }`. `success: false` → `VALIDATION_ERROR` with `message`. No follow-up read: new parcels are `En préparation` → `pending`. |
| `track` | `GET parcels/{tracking}` + `GET histories/{tracking}` | Both return `{ has_more, total_data, data: [...], links }`. Empty `data` on the parcel call → `NOT_FOUND`. |
| `getFees` | `GET fees/?from_wilaya_id=&to_wilaya_id=` | Returns zone-level fees plus `per_commune` map (see below). |
| `getWilayas` | `GET wilayas/` | Paginated (`page`, `page_size=1000` — the maximum, default is 100 — `has_more`). Wilaya `id` **is** the official code. Items with `is_deliverable = 0` skipped. |
| `getCommunes` | `GET communes/?wilaya_id=` | Paginated (`page_size=1000`). Items with `is_deliverable = 0` skipped. |
| `getStopDesks` | `GET centers/?wilaya_id=[&commune_id=]` | Paginated. `center_id` → `StopDesk.id` (Yalidine's `stopdesk_id`), `name`, `address`, `commune_id`, `wilaya_id`. `communeId` is optional (id or name). |
| `cancelParcel` | `DELETE parcels/{tracking}` | Response `[{ tracking, deleted }]`. Only parcels in `En préparation` can be deleted; `deleted: false` → `VALIDATION_ERROR`. `id` = tracking for Yalidine. |
| `healthCheck` | `GET wilayas/` | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

### `ParcelInput` → `POST parcels/` body

| Unified field | Yalidine field | Notes |
|---------------|----------------|-------|
| `recipientName` | `firstname`, `familyname` | Split on the first space; single-word names are sent in both fields. |
| `phone` (+ `phone2`) | `contact_phone` | Local format `0XXXXXXXXX`; `phone2` appended comma-separated. |
| `address` | `address` | |
| `wilayaId` / `wilayaName` | `to_wilaya_name` | Yalidine wants **names**: ids/codes and user names are resolved to the canonical name via `wilayas/`. |
| `communeId` / `communeName` | `to_commune_name` | Resolved to the canonical name via `communes/?wilaya_id=`. |
| — | `from_wilaya_name` | From the `fromWilayaId` / `fromWilayaName` client option. |
| `productName` / `productList` | `product_list` | String; list names joined with `, ` (`Mug x2, Tee`). |
| `price` | `price` | Amount collected. We always send **`freeshipping: true`** so Yalidine does *not* add its fee on top — `price` is exactly what the recipient pays (fees are deducted from the COD). |
| — | `declared_value` | `price`; `do_insurance: false`. |
| `weight`, `length`, `width`, `height` | same names | kg / cm. **Required integers**: always sent, `0` when missing, decimals rounded up. |
| `isStopDesk` / `stopDeskId` | `is_stopdesk` / `stopdesk_id` | When stop-desk, the SDK loads `centers/?wilaya_id=` and, if the `center_id` matches, sends that center's `commune_name` / `wilaya_name` as `to_*` (avoids API rejection on stopdesk/commune mismatch — same fix as Delivery GuepEx). Unknown `stopDeskId` still posts; the API returns `success: false`. |
| `orderId` | `order_id` | Required by Yalidine; generated (`dzd-<random>`) when absent. |
| `remark` | — | Not sent (no known field). |
| — | `has_exchange` | Always `false` in MVP. |

### Response → `Parcel` / `TrackingEvent`

| Unified | Yalidine |
|---------|----------|
| `Parcel.id`, `Parcel.trackingNumber` | `tracking` (e.g. `yal-ABC123`) |
| `Parcel.status` | `last_status` → mapped |
| `TrackingEvent.status` | `status` → mapped |
| `TrackingEvent.label` | `status` (+ ` (reason)` when `reason` is set) |
| `TrackingEvent.at` | `date_status` (`YYYY-MM-DD HH:MM:SS`, interpreted as `Africa/Algiers`, i.e. `+01:00`) |

### Fees → `FeeQuote`

`GET fees/` response: `{ from_wilaya_name, to_wilaya_name, zone, retour_fee, cod_percentage, insurance_percentage, oversize_fee, per_commune: { "<commune_id>": { commune_id, commune_name, express_home, express_desk, economic_home, economic_desk } } }`.

| Unified | Yalidine |
|---------|----------|
| `deliveryFee` | `per_commune[toCommuneId].express_home` (or `express_desk` when `isStopDesk`). Without `toCommuneId`, the first commune entry is used. |
| `stopDeskFee` | `express_desk` (fallback key `express_stopdesk`) |
| `returnFee` | `retour_fee` |
| weight surcharge | Billable weight = `max(weight, length × width × height × 0.0002)` (volumetric only when the 3 dimensions are given). When > 5 kg: `(billable − 5) × oversize_fee`, rounded up to the dinar, added to both fees. |

Missing price for the requested mode → `NOT_FOUND`.

### Status mapping

Compared case/accent-insensitively. Reference cases: [`fixtures/yalidine/statuses.json`](./fixtures/yalidine/statuses.json).

| Native `status` / `last_status` | Unified |
|---------------------------------|---------|
| `En préparation`, `A vérifier` | `pending` |
| `Pas encore expédié`, `Pas encore ramassé`, `Prêt à expédier`, `En passation` | `created` |
| `Ramassé`, `Expédié`, `Centre`, `En localisation`, `En transit`, `Vers Wilaya`, `Reçu à Wilaya`, `Transfert`, `Vers Station`, `En station`, `Prêt pour livreur`, `Dispatché`, `Sorti en livraison`, `En attente du client`, `En attente`, `Tentative échouée`, `Echèc livraison`, `En alerte`, `Alerte résolue`, `Bloqué`, `Débloqué` | `in_transit` |
| `Livré` | `delivered` |
| `Retour …`, `Retourné …`, `Echange échoué`, `Colis abandonné` | `returned` |
| `Annulé`, `Supprimé` | `cancelled` |
| anything else | `unknown` |

### Errors / rate limits

- Error bodies (not documented by Yalidine; assumed) look like `{ "error": { "code": 400, "message": "..." } }` → `ShippingError.message` ← `error.message`. HTTP status → `code` per `CONTRACT.md` §3.
- Yalidine enforces per-second / minute / hour / day quotas (reported in `x-second-quota-left`, `x-minute-quota-left`, `x-hour-quota-left`, `x-day-quota-left` response headers). Defaults: 5/s, 50/min, 1 000/h, 10 000/day. `429` → `RATE_LIMITED`, with `ShippingError.retryAfter` set from the `Retry-After` header. The SDK does not retry automatically.

### Implementation notes (TS + PHP)

Same mapping as above, plus:

- Wilaya ids/codes/names are always resolved through the cached `wilayas/` list (so `getFees` / `getCommunes` / `createParcel` make one extra call on a fresh client). Unknown wilaya or commune → `NOT_FOUND` before the parcel is posted.
- Phone numbers that are not valid Algerian numbers → `VALIDATION_ERROR` before any HTTP call. Missing `fromWilayaId` / `fromWilayaName` is also checked before any HTTP call.
- `histories/` pagination is followed when `has_more` is `true` (`page_size=1000`) in both TS and PHP.
- A parcel lookup that returns empty `data` throws `NOT_FOUND` without `httpStatus` (the HTTP call itself returned `200`).
- The Delivery sync layer uses client-side quota throttling (5/s, 50/min, 1 000/h, 10 000/day) and `GET parcels/?tracking=`; the SDK maps `429` → `RATE_LIMITED` (with `retryAfter` from `Retry-After`) and tracks via `GET parcels/{tracking}` per the official docs. No automatic retry / client throttle in the SDK.
- Confirmed by the docs: list endpoints accept `page` / `page_size`; `contact_phone` accepts comma-separated numbers; `freeshipping: true` = the sender pays the delivery fee; `stopdesk_id` is a `center_id` from `centers/`.
- Still to confirm with real responses: error body format; whether Yalidine rounds the overweight kg.

---

## Maystro Delivery

> Built from the public API docs (saved in [`vendor/maystro/maystro-api-full.md`](./vendor/maystro/maystro-api-full.md)) on 2026-10-20, then aligned with Confirmation-api live fees (`MaystroController::getDeliveryPrice`) on 2026-10-20. No sandbox response has been captured yet: fixtures are derived from the doc examples + Confirmation production paths.

- Docs: <https://maystro.gitbook.io/maystro-delivery-documentation/reference/maystro-delivery-api-reference>
- Orders / locations base URL: `https://orders-management.maystro-delivery.com` (`MAYSTRO_DEFAULT_BASE_URL` / `MaystroProvider::DEFAULT_BASE_URL`; keep the trailing `/` on `api/base/...` and `api/orders/`)
- Live fees base URL: `https://backend.maystro-delivery.com` (`MAYSTRO_BACKEND_BASE_URL` / `MaystroProvider::BACKEND_BASE_URL`) — Confirmation-api production host for tariffs (and geo sync uses `api/shared/wilayas/` on this host / communes on backend2; SDK locations still use orders-management `api/base/...`)

### Auth

| Header | Value | Config key |
|--------|-------|------------|
| `Authorization` | `Token <token>` | `apiToken` (`MAYSTRO_API_TOKEN`) |
| `Accept` / `Content-Type` | `application/json` | — |

> **Assumption:** the orders page literally says `Authorization: token` ("replace `<token>` with your token"), while the webhook pages say `token <store token>`. The API is Django REST Framework, whose `TokenAuthentication` expects `Token <key>`, so the SDK sends `Authorization: Token <apiToken>`. A token that already starts with `Token ` is sent unchanged.

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST /api/orders/` | Body is a **list** of orders (bulk, we send one). Trailing `/` matches the live orders-management URL. Response: `[{ id, external_id, tracking, success, delivery_price, errors: [] }]`. `success: false` or non-empty `errors` → `ShippingError` (see Errors). No follow-up read (no read endpoint): status is always `pending`. |
| `track` | — | **Not supported** (`NOT_SUPPORTED`, no HTTP call). Maystro documents no order read/tracking endpoint; status changes are pushed by webhooks (`OrderStatusChanged`, `payload.status` = numeric code). Map them with `mapMaystroStatus` (TS) / `StatusMapper::maystro()` (PHP). |
| `getFees` | **Primary:** `GET {backend}/api/stores/delivery_price/?commune=&delivery_type=&express=false` (home=`1`, stop desk=`2`). **Fallback:** orders-management `GET /api/base/delivery-options/?commune=` then `GET /api/base/delivery-prices/?commune=&delivery_type=` | Matches Confirmation-api live tariffs. Response shape `{ delivery_price: number }`. SDK calls type `1` and `2` to fill `deliveryFee` + `stopDeskFee`. On `NOT_FOUND` / `NETWORK_ERROR` from the backend host, falls back to legacy `delivery-options` (all modes in one call) then `delivery-prices` (`1` home, `2` stop desk, `3` pickup). `createParcel` stays on orders-management. |
| `getWilayas` | `GET /api/base/wilayas/?language=fr&country=1` | Current response: objects `{ code, display_id, name_lt, name_ar, … }` (`code` → `Location.id`). Legacy `[id, name]` tuples and `{ id, name }` are still accepted. Wilaya id **is** the official code. Not paginated. |
| `getCommunes` | `GET /api/base/communes/?wilaya=<id>` | Response: `[{ id, wilaya, name, postcode, zone }]`. A DRF page `{ results: [...] }` is also accepted (first page only). |
| `getStopDesks` | `GET /api/base/pickup-points?commune=<id>` | **`communeId` required** (`VALIDATION_ERROR` otherwise). Response `[{ name_lt, name_ar, commune, pickup_point, delivery_type, active }]`. Stop desk (`delivery_type: 2`, `pickup_point: null`) → `id` = commune id; pickup point (`delivery_type: 3`) → `id` = `pickup_point`. `active: false` skipped. |
| `cancelParcel` | — | **Not supported** (`NOT_SUPPORTED`, no HTTP call): no documented cancellation endpoint. |
| `healthCheck` | `GET /api/base/wilayas/` | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

### `ParcelInput` → `POST /api/orders/` body

| Unified field | Maystro field | Notes |
|---------------|---------------|-------|
| `recipientName` | `customer_name` | |
| `phone` | `customer_phone` | Local format `0XXXXXXXXX`. |
| `phone2` | `customer_phone2` | Same normalization; omitted when absent. |
| `address` | `destination_text` | |
| `wilayaId` / `wilayaName` | `wilaya` | Maystro wants the wilaya **name**: id/code/name resolved to the canonical name via `wilayas/`. |
| `communeId` / `communeName` | `commune` | Sent as the integer commune **id**, resolved (and checked) via `communes/?wilaya=`. Unknown wilaya/commune → `NOT_FOUND` before the order is posted. |
| `productList` | `details[]` | `{ product: sku ?? "", description: name, quantity }`. `sku` is sent as Maystro's `product` (its `id` or your external `product_id`); empty `product` lets Maystro create the product from `description`. |
| `productName` | `details[]` | One item: `{ product: "", description: productName, quantity: 1 }`. |
| `price` | `total_price` | **Includes the delivery fee** (Maystro deducts its fee from it). Rounded to an integer (Maystro requires one). |
| `isStopDesk` / `stopDeskId` | `delivery_type`, `pickup_point` | `false` → `delivery_type: 1` (home). `true` and `stopDeskId` equal to the destination **commune id** → `delivery_type: 2` (that commune's Maystro stop desk, which has no id of its own). `true` with any other `stopDeskId` → `delivery_type: 3` (pickup point) and `pickup_point: stopDeskId` (ids from `GET /api/base/pickup-points?commune=` or `delivery-options` `pickup_point_id`). |
| `remark` | `note_to_driver` | Omitted when absent. |
| `orderId` | `external_id` | Max 100 chars (Maystro error `100`). Omitted when absent. |
| — | `express` | Always `false`. |
| `weight`, `length`, `width`, `height` | — | Not sent (no such fields). |

> ⚠️ **Duplicate rule:** Maystro rejects (error `55`) an order with the same `customer_name` + `customer_phone` (or + `customer_phone2`) as another order created in the **last 24 hours**. Retrying a create after a timeout can therefore fail with `VALIDATION_ERROR` even though the first order exists.

### Response → `Parcel`

| Unified | Maystro |
|---------|---------|
| `id` | `id` (UUID; falls back to `tracking`) |
| `trackingNumber` | `tracking` (e.g. `172316976800001`) |
| `status` | always `pending` (the response has no status; new orders start as `4` / `CREATED` → `pending`) |
| `provider` | `"maystro"` |

### Locations → `Location`

| Unified | Wilaya (`code` / legacy `[id, name]`) | Commune |
|---------|------------------------|---------|
| `id` | `code` (fallback `display_id` / `id`) | `id` |
| `name` | `name_lt` (fallback `name` / `name_ar`) | `name` |
| `parentId` | — | `wilaya` |
| `code` | `id` (official code) | `postcode` |

### Fees → `FeeQuote`

`GET /api/base/delivery-options/?commune=` response (legacy / some stores): `[{ type: "home" | "stopdesk" | "pickup", name, price, min_total_price, required_points, current_points, pickup_point_id? }]`.

`GET /api/base/delivery-prices/?commune=&delivery_type=` response (fallback): `{ delivery_price, min_total_price, required_points, current_points }`.

| Unified | Maystro |
|---------|---------|
| `deliveryFee` | `price` of `type: "home"`, or of the stop-desk price below when `isStopDesk` |
| `stopDeskFee` | `price` of `type: "stopdesk"`, falling back to the first `type: "pickup"` entry |
| `returnFee` | not exposed |
| `currency` | `"DZD"` |

Prices are **per commune**. Like Yalidine, when `toCommuneId` is missing the **first commune** returned by `communes/?wilaya=` for `toWilayaId` is used (2 extra calls). With `toCommuneId`, it is sent as-is (one call; `toWilayaId` is only checked for presence). `weight` / dimensions are ignored (no documented surcharge). Missing price for the requested mode, or `404 PRICING NOT FOUND` → `NOT_FOUND`.

### Status mapping

Maystro reports numeric codes (webhooks send `payload.status`). The mapper accepts the code (`41`, `"41"`) or the name (`DELIVERED`, `ready to return`; case/separator-insensitive). Reference cases: [`fixtures/maystro/statuses.json`](./fixtures/maystro/statuses.json).

| Code | Native name | Unified | Why |
|------|-------------|---------|-----|
| 4 | `CREATED` | `pending` | Registered, not yet handed over / pickup not requested. |
| 11 | `PENDING` | `pending` | On hold before preparation. |
| 12 | `OUT_OF_STOCK` | `pending` | Premium stores: cannot be prepared yet. |
| 5 | `PICK_UP_REQUESTED` | `created` | Ready to be picked up by Maystro. |
| 6 | `IN_PROCESS` | `created` | Being processed/prepared by Maystro, not moving yet. |
| 8 | `WAITING_TRANSIT` | `in_transit` | In hub, waiting for transfer. |
| 9 | `IN_TRANSIT_TO_BE_SHIPPED` | `in_transit` | |
| 15 | `READY_TO_SHIP` | `in_transit` | Held by Maystro (picked up for Starter, in warehouse for Premium), ready for a driver. |
| 22 | `ASSIGNED` | `in_transit` | Assigned to a driver. |
| 31 | `SHIPPED` | `in_transit` | Out for delivery. |
| 32 | `ALERTED` | `in_transit` | Delivery issue / failed attempt. |
| 42 | `POSTPONED` | `in_transit` | |
| 41 | `DELIVERED` | `delivered` | |
| 50 | `ABORTED` | `cancelled` | Maystro itself calls `50` "CANCELLED" (refund section). If the parcel was already shipped, the following `51` / `10` / `52` map to `returned`. |
| 10 | `IN_TRANSIT_TO_BE_RETURNED` | `returned` | |
| 51 | `READY_TO_RETURN` | `returned` | (alias `READY_TO_BE_RETURNED`) |
| 52 | `TAKEN_BY_STORE` | `returned` | Return handed back to the store. |
| 53 | `NOT_RECEIVED` | `returned` | Return reported as not received by the store. |
| other | | `unknown` | |

Name aliases `CANCELLED` / `CANCELED` → `cancelled`.

### Errors

Rejected orders come back as result rows with numeric `errors` codes. Entries may be bare codes (`[40]`) or objects (`[{ code, message }]`) — the docs only show an empty list, so both are accepted. The **first known code** decides `ShippingError.code`; every entry becomes a detail `{ field?, message, code: "<maystro code>" }` (native `message` when present, otherwise the table text). `ShippingError.message` = detail messages joined with `; `. The same parsing applies when the rows come back with an HTTP 4xx (the HTTP status then decides `code`).

| Maystro code | Meaning | `ShippingError.code` | `details[].field` |
|--------------|---------|----------------------|-------------------|
| 10 | Price not valid / missing | `VALIDATION_ERROR` | `price` |
| 20 | Address missing | `VALIDATION_ERROR` | `address` |
| 30 | Customer name/phone not valid | `VALIDATION_ERROR` | `phone` |
| 40 | Wilaya or commune does not exist | `NOT_FOUND` | `communeId` |
| 45 | Delivery type not available for the commune | `VALIDATION_ERROR` | `isStopDesk` |
| 50 | Products missing / not valid | `VALIDATION_ERROR` | `productList` |
| 55 | Duplicated order (same name/phone within 24 h) | `VALIDATION_ERROR` | — |
| 60 | Unexpected error | `PROVIDER_ERROR` | — |
| 70 | Delivery pricing could not be detected | `PROVIDER_ERROR` | — |
| 80 | Orders list empty | `VALIDATION_ERROR` | — |
| 90 | Too many orders (> 1000) | `VALIDATION_ERROR` | — |
| 100 | External ID > 100 chars | `VALIDATION_ERROR` | `orderId` |
| 101 | Not enough points to pay the delivery | `VALIDATION_ERROR` | — |
| other / none | | `VALIDATION_ERROR` | — |

Other error bodies are assumed to follow DRF: `{ "detail": "..." }` → `message`; `{ "<field>": ["..."] }` → `details[{ field, message }]`. HTTP status → `code` per `CONTRACT.md` §3 (`401` → `AUTH_FAILED`, `404` → `NOT_FOUND`, …).

### Limitations and assumptions

- **No `track` / `cancelParcel`** (`NOT_SUPPORTED`): use Maystro webhooks + the exported status mapper.
- `createParcel` always returns `pending`; Premium stores may actually start at `15` (`READY_TO_SHIP`, as in the `orderCreated` webhook example).
- Auth header format `Token <token>` (see Auth). Same token is sent to both hosts.
- Wilaya ids are assumed to equal the official codes `1`–`58` (true for every id in the docs example), so `code = id`.
- Error entry shape (`40` vs `{ code, message }`) and non-order error bodies are not documented (see Errors).
- Bulk create, exchanges, refunds, products/stock, pickup points listing, order slips and webhook management are out of MVP scope.

---

## Confirmation-api fees audit (2026-10-20)

Cross-check of live tariff sources in Confirmation-api vs this SDK (orders / create stay on each carrier’s documented host):

| Carrier | Confirmation live fees | SDK |
|---------|------------------------|-----|
| **GuepEx** | `GET https://api.guepex.app/v1/fees/` | Same API as Yalidine — use `YalidineProvider` with `GUEPEX_DEFAULT_BASE_URL` ✓ |
| **ZRExpress** | Tariffs from **DB only** in Confirmation; the guide has **no** fees HTTP endpoint | SDK uses live `GET /api/v1/delivery-pricing/rates/{toTerritoryId}` ✓ |
| **Ecotrack** (DHD, Anderson, …) | `GET /api/v1/get/fees` | Already in SDK ✓ |
| **Maystro** | `GET https://backend.maystro-delivery.com/api/stores/delivery_price/?commune=&delivery_type=&express=` | SDK primary path (this change); orders-management options/prices kept as fallback ✓ |
| **NoEST / MDM / Ecom** | — | Still backlog (see below) |

---

## Ecotrack

> Ecotrack is not a courier but a white-label platform: DHD, Anderson, World Express, 48Hr Express, EcoRapid, Conexlog, MSM Go, Packers and ~80 other couriers expose the **same API** on their own domain. One provider (`ecotrack`) serves all of them; the tenant is chosen with `courier` or `baseUrl`.
> Built from third-party integration notes on the official Postman collection (`docs/vendor/ecotrack/`, private) and cross-checked against `Delivery/Ecotrack.php` tenant hosts. Needs confirmation with real responses per tenant.
>
> **Same API, not separate providers:** Anderson, DHD, World Express, 48Hr Express and EcoRapid in the legacy app are Ecotrack tenants (Bearer + `/api/v1`). Do **not** add `anderson` / `mdm` / `elogistia` as separate SDK providers for that reason — MDM and Elogistia use different APIs (see remaining / out of scope below).

- Base URL: `https://<tenant>/api/v1` (paths below are relative to it). Single-order endpoints take **query parameters**, never a JSON body.

### Auth / tenant

| Option | Value | Notes |
|--------|-------|-------|
| `token` | API token from the courier's dashboard | Sent as `Authorization: Bearer <token>` (a `Bearer ` prefix in the value is stripped). |
| `courier` | built-in tenant key | Exactly one of `courier` / `baseUrl`. Unknown key → `VALIDATION_ERROR`. |
| `baseUrl` | tenant URL, e.g. `https://xyz.ecotrack.dz` | Must be `https`; a trailing `/api/v1` is stripped. |
| `autoValidate` | `false` (default) | `true` → `POST valid/order` right after creation, so the courier picks the order up. |

Built-in `courier` keys. Hosts marked **Delivery** match `Delivery/Ecotrack.php` `EntrepriseName` (production). Others are from integration notes — use `baseUrl` if yours differs:

| Key | Host | Source |
|-----|------|--------|
| `dhd` | `https://platform.dhd-dz.com` | Delivery |
| `anderson` | `https://anderson-ecommerce.ecotrack.dz` | Delivery (`andersondelivery` is an alias of the same host) |
| `worldexpress` | `https://world-express.ecotrack.dz` | Delivery |
| `48hrexpress` | `https://48hr.ecotrack.dz` | Delivery |
| `ecorapid` | `https://ecorapide-express.ecotrack.dz` | Delivery |
| `conexlog` | `https://app.conexlog-dz.com` | notes |
| `msmgo` | `https://msmgo.ecotrack.dz` | notes |
| `packers` | `https://packers.ecotrack.dz` | notes |
| `rocketdelivery` | `https://rocketdelivery.ecotrack.dz` | notes |

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST create/order?…` | Query parameters (below). Tracking is read from `tracking` (or `tracking_number` / …) at the root, under `data`, `data.order`, or `order` — some tenants nest it. With `autoValidate`, followed by `POST valid/order?tracking=`; a validation failure says the order *was created*. |
| `track` | `GET get/tracking/info?tracking=` | Only the entry for this exact tracking number is used (never "the first row"). |
| `getFees` | `GET get/fees` | All wilayas in one call; the row whose `wilaya_id` matches is used. |
| `getWilayas` | `GET get/wilayas` | Only the wilayas the tenant delivers to. `wilaya_id` is the official code. |
| `getCommunes` | `GET get/communes?wilaya_id=` | Answer is an **index-keyed object**, not a list. `Location.id` = `code_postal` (or the name when missing). |
| `getStopDesks` | `GET get/communes?wilaya_id=` | Communes with `has_stop_desk: 1`; `StopDesk.id` = the commune's `code_postal` (Ecotrack "station code"). |
| `cancelParcel` | `DELETE delete/order?tracking=` | Only before validation: error `10001` or `delete: "fail"` → `VALIDATION_ERROR`. |
| `healthCheck` | `GET get/wilayas` | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

### `ParcelInput` → `create/order` query

| Unified field | Ecotrack field | Notes |
|---------------|----------------|-------|
| `recipientName` | `nom_client` | |
| `phone` / `phone2` | `telephone` / `telephone_2` | Local format `0XXXXXXXXX`. |
| `address` | `adresse` | |
| `wilayaId` / `wilayaName` | `code_wilaya` | Code `1`–`58`; names resolved via `get/wilayas`. |
| `communeId` / `communeName` | `commune` | Commune **name**, in the tenant's spelling (resolved via `get/communes`). |
| `productName` / `productList` | `produit` | Joined names (`Mug x2, Tee`). |
| `price` | `montant` | Rounded. **Includes the delivery fee**: what the recipient pays. |
| — | `type` | Always `1` (delivery). |
| `isStopDesk` / `stopDeskId` | `stop_desk` (`0`/`1`) / `code_postal` | `stopDeskId` = a `getStopDesks()` id. |
| `weight` | `weight` | Only when given. Dimensions are not sent. |
| `remark` | `remarque` | |
| `orderId` | `reference` | |

New orders are `pending` (`prête à expédier`) until validated; `created` with `autoValidate`.

### Tracking → `Parcel` / `TrackingEvent`

`activity[]` rows (`status`, `reason`, `date`, `time`) are sorted oldest first. `TrackingEvent.at` = `date` + `time` as `+01:00`; `label` = activity key (+ ` (reason)`). The parcel status is the last mapped activity; `notification_on_order` (a remark) keeps the previous status. No activity → `pending`. Unknown tracking (empty result, or a `422` whose only invalid field is `tracking`) → `NOT_FOUND`.

### Fees → `FeeQuote`

| Unified | Ecotrack |
|---------|----------|
| `deliveryFee` | `livraison[wilaya].tarif` (home) or `tarif_stopdesk` (`isStopDesk`) |
| `stopDeskFee` | `livraison[wilaya].tarif_stopdesk` |
| `returnFee` | `retours[wilaya].tarif` (or `tarif_stopdesk`) |

A `0` price means the mode is not offered → `NOT_FOUND`. Fees are per wilaya (no per-commune price, no weight surcharge).

### Status mapping

Only the stable **keys** are mapped (activity keys and order status enum keys); French display labels drift per tenant and map to `unknown`. Compared case-insensitively. Reference cases: [`fixtures/ecotrack/statuses.json`](./fixtures/ecotrack/statuses.json).

| Native key | Unified |
|------------|---------|
| `prete_a_expedier`, `prete_a_preparer` | `pending` |
| `order_information_received_by_carrier`, `en_preparation_stock`, `en_ramassage` | `created` |
| `picked`, `accepted_by_carrier`, `dispatched_to_driver`, `attempt_delivery`, `vers_hub`, `en_hub`, `vers_wilaya`, `en_preparation`, `en_livraison`, `suspendu` | `in_transit` |
| `livred`, `encaissed`, `payed`, `livre_non_encaisse`, `encaisse_non_paye`, `paiements_prets`, `paye_et_archive` | `delivered` |
| `return_asked`, `return_in_transit`, `return_received`, `retour_chez_livreur`, `retour_transit_entrepot`, `retour_en_traitement`, `retour_recu`, `retour_archive` | `returned` |
| `annule` | `cancelled` |
| anything else (incl. `notification_on_order`, French labels) | `unknown` |

### Errors / rate limits

- Validation failures: HTTP `422` Laravel bodies `{ message, errors: { field: [..] } }` → `VALIDATION_ERROR` with one `details` entry per message.
- Business failures come back as **HTTP 200** `{ success: false, error: <code> }`:

| Code | Unified | Meaning |
|------|---------|---------|
| `10001` | `VALIDATION_ERROR` | Order already validated (cannot be modified / deleted). |
| `10002` | `VALIDATION_ERROR` (`field: wilayaId`) | No delivery to this wilaya. |
| `10003` | `VALIDATION_ERROR` | A return cannot be requested for this order. |
| other | `PROVIDER_ERROR` | `details[0].code` holds the native code. |

- Rate limit: about **50 requests/minute** → `429` (`Too Many Attempts.`) → `RATE_LIMITED` (+ `retryAfter` when sent). `autoValidate` makes 2 calls per order.
- Field limits (from the notes): phone 9–10 digits, wilaya code `1`–`58`, strings ≤ 255 chars; a misspelled commune name is a `422`.

### Limitations and assumptions

- Updating an order, requesting returns (`ask/for/order/return`) and validating returns are out of MVP scope. Ecotrack silently ignores updates after validation.
- Tenant hosts other than the built-in keys must be passed as `baseUrl`.
- Response shapes vary slightly between tenants (lists vs index-keyed objects, `data` wrappers); the provider accepts both.
- Legacy app price tables (`AndersonPriceController`, `DhdPriceController`) are DB-backed, not Ecotrack `get/fees` — the SDK uses the live API.
- **Not Ecotrack (do not use this provider):** NoEST (`app.noest-dz.com`, different auth/paths), MDM (JWT / `x-api-key`), Elogistia (`api.elogistia.com`).

---

## Out of MVP / backlog

Carriers present in the legacy `Delivery/` monolith but **not** implemented in the SDK yet. Do not add code until fixtures + a full method table exist (same bar as ZRExpress / Yalidine).

### Ecom (out of MVP / backlog)

> Audited against `Delivery/EcomDelivery.php` + `Delivery/DeliveryController.php` (2026-10-20). Legacy `delivery_companies.id = 19`, name `Ecom`. **Not trivial**: create/track hit the public API; fees / wilayas / communes / stop desks are served from local delivery DB tables (`ecom_delivery_prices`, `ecom_delivery_communes`, `ecom_delivery_stopdesks`) — no live location/fee HTTP endpoints in the adapter. No `sync_status_ecom_*.log` samples in-repo at audit time.

- Base URL: `https://ecom-dz.net` (override env `ECOM_DELIVERY_BASE_URL`)
- API prefix: prefer `/Api_v1/…` (create colis); tracking/list may need fallback `/API_v1/…` when the server returns 404/500 “aucun point d'entrée”

#### Auth (proposed SDK config)

| Header | Value | Config key |
|--------|-------|------------|
| `Key` | API key | `apiKey` (`ECOM_API_KEY`) |
| `Token` | API token | `apiToken` (`ECOM_API_TOKEN`) |
| `Page` | pagination (default `1`) | — |
| `Accept` / `Content-Type` | `application/json` | — |

#### Proposed method mapping

| Unified method | Native / source in legacy | Notes for a future SDK provider |
|----------------|---------------------------|----------------------------------|
| `createParcel` | `POST /Api_v1/Colis` body `{ Colis: [ {…} ] }` | Response `Colis[0].Tracking` → `trackingNumber`. Map `ParcelInput` → `NomComplet`, `Mobile_1`/`Mobile_2`, `Adresse`, `Wilaya` (code), `Commune` (**exact name**), `Article`, `Ref_Article`, `Total`, `ID_Externe`, `Stopdesk`/`CodeStopdesk`, `Echange`, `NoteFournisseur`, `Source`. |
| `track` | `GET …/Colis/Tracking/{tracking}` (+ `/API_v1/` fallback); optional `POST …/Colis/Liste` (≤100) | Parcel may be a single object or list under `Colis`/`colis`. Status from `Avancement` + `Situation`; `Date_Livrée`/`Date_Livree` non-null → `delivered`. |
| `getFees` | **DB** `ecom_delivery_prices` (`tarif` / `tarif_stopdesk`) | No HTTP fee API in adapter → SDK either needs a documented native endpoint, or ships static/fixture data, or returns `NOT_SUPPORTED` until then. |
| `getWilayas` | **DB** distinct `ecom_delivery_communes.wilaya_id` (+ names via `yalidine_wilayas`) | Same caveat as fees. |
| `getCommunes` | **DB** `ecom_delivery_communes` | Includes derived `has_stop_desk` from stopdesk name match. |
| `getStopDesks` | **DB** `ecom_delivery_stopdesks` | `stopdesk_code` → `StopDesk.id` / create `CodeStopdesk`. |
| `cancelParcel` | — | **Not present** in legacy → likely `NOT_SUPPORTED`. |
| `healthCheck` | probe `GET /Api_v1/Colis` or Tracking with dummy | TBD once live credentials exist. |

#### Status mapping (draft from legacy `mapColisToPlatformStatus`)

| Native signal | Unified |
|---------------|---------|
| non-empty `Date_Livrée` / `Date_Livree` | `delivered` |
| text contains `perdu` | map via platform helper (failed / returned — confirm) |
| other `Avancement` / `Situation` | normalize through shared status helper → often `in_transit` / `unknown` until fixtures exist |

#### Blockers before implementation

1. Capture anonymized JSON fixtures for create, track, and (if any) live wilayas/fees endpoints — or formally decide locations/fees are `NOT_SUPPORTED` / offline catalog.
2. Confirm official PDF/docs for path casing and error bodies.
3. Add `T6.1c` work only after the above; keep TS and PHP in lockstep with this table.

---

## Adding a provider

Copy the ZRExpress section structure (Auth, Method mapping, Field mapping, Status mapping, Errors) and see [`CONTRIBUTING.md`](../CONTRIBUTING.md#how-to-add-a-provider).

