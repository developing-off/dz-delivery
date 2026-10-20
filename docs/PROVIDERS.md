# Provider mapping

How each carrier's native API maps to the unified [`ShippingProvider`](./CONTRACT.md#5-shippingprovider-interface) methods.
TS and PHP implementations MUST follow these tables. Update this file **before** changing a provider's behavior.

| Provider | Key | Status |
|----------|-----|--------|
| ZRExpress | `zrexpress` | mapping drafted, implemented in PHP and TS |
| Yalidine | `yalidine` | mapping checked against the developer docs (2026-10-20), implemented in PHP and TS |
| Maystro Delivery | `maystro` | built from the public API docs (2026-10-20), implemented in PHP and TS; `track` / `cancelParcel` not supported |
| Ecotrack (DHD, Conexlog, …) | `ecotrack` | built from third-party notes on the official Postman collection (2026-10-20), implemented in PHP and TS |

---

## ZRExpress

- Docs: <https://docs.zrexpress.app/reference>
- Base URL: `https://api.zrexpress.app`
- API version: path segment `/api/v1/...` (the docs also show `v1.0`; use `v1`).

### Auth

Every request sends:

| Header | Value | Config key |
|--------|-------|------------|
| `X-Api-Key` | API key | `apiKey` (`ZREXPRESS_API_KEY`) |
| `X-Tenant` | Tenant ID | `tenant` (`ZREXPRESS_TENANT`) |
| `Accept` / `Content-Type` | `application/json` | — |

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST /api/v1/parcels` | Returns `201 { id }` only → follow up with `GET /api/v1/parcels/{id}` to fill `trackingNumber` and `status`. |
| `track` | `GET /api/v1/parcels/{trackingNumber}` + `GET /api/v1/parcels/{parcelId}/state-history` | First call gives the current parcel and its UUID `id`; second gives the event list. |
| `getFees` | `GET /api/v1/delivery-pricing/rates/{toTerritoryId}` | Also available: `GET /api/v1/delivery-pricing/rates` (all territories). Pick the `deliveryPrices[]` entry matching `deliveryType` (`home` / `pickup-point`). |
| `getWilayas` | `POST /api/v1/territories/search` | Filter `level = "wilaya"`. Paginated (`pageSize` ≤ 1000); loop over pages while `hasNext`. Body: `{ pageNumber, pageSize, orderBy: ["code asc"], advancedFilter: { logic: "and", filters: [{ field, operator: "eq", value }] } }`. Territories whose `delivery.hasHomeDelivery` and `delivery.hasPickupPoint` are both `false` are skipped. |
| `getCommunes` | `POST /api/v1/territories/search` | Filter `level = "commune"` and `parentId = <wilaya id>`. |
| `getStopDesks` | — | `NOT_SUPPORTED`: no hub listing endpoint documented yet. Pass the hub UUID as `stopDeskId` yourself. |
| `cancelParcel` | `DELETE /api/v1/parcels/{id}` | Requires the parcel **UUID**. If given a tracking number, resolve it first with `GET /api/v1/parcels/{trackingNumber}`. Returns `204`. |
| `healthCheck` | `POST /api/v1/territories/search` (wilayas) | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

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
| `productName` / `productList` | `orderedProducts[]` (`productName`, `quantity`, `unitPrice`, `productSku`) | Use `stockType: "none"` in MVP (no catalog). `productName` → one item, `quantity: 1`, `unitPrice: price`. |
| `productName` / joined names | `description` | Required, 2–250 chars. |
| `price` | `amount` | ≤ 150 000 DZD, **includes delivery fee**. |
| `weight` | `weight.weight` | kg. |
| `length` / `width` / `height` | `orderedProducts[0].length/width/height` | No parcel-level dimensions; applied to the first item. |
| `isStopDesk` | `deliveryType` | `false` → `"home"`, `true` → `"pickup-point"`. |
| `stopDeskId` | `hubId` | Required when `deliveryType = "pickup-point"`. |
| `remark` | — | No dedicated field found yet; **not sent** for now. TODO (maybe append to `description`). |
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
| `OutForDelivery`, other hub / transfer states | `in_transit` |
| `Delivered` / `livre` (TODO: confirm) | `delivered` |
| `Returned` / `retour*` (TODO: confirm) | `returned` |
| `Cancelled` / `annule` (TODO: confirm) | `cancelled` |
| anything else | `unknown` |

Implementation detail (until real fixtures exist): names are compared after lowercasing, stripping accents and removing `_`, `-`, spaces. Order: exact pending/created/delivered/cancelled names → `returned` if it starts with `return`/`retour` → `in_transit` if it contains a transit keyword (`outfordelivery`, `transit`, `hub`, `transfer`, `dispatched`, `expedie`, `pickedup`, `attempt`, `echec`, `failed`, …) → `unknown`. Reference cases: [`fixtures/zrexpress/statuses.json`](./fixtures/zrexpress/statuses.json).

> TODO (both packages): the state-history example in the ZRExpress docs also shows `confirme_au_bureau` (parcel confirmed at the office → `in_transit`) and `encaisse` (COD collected → `delivered`). Neither matches the rules above, so both currently map to `unknown`. Add them to the exact table in TS **and** PHP, plus `statuses.json`, in the same PR.

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

> Checked against the official developer docs (login required) on 2026-10-20. Error bodies are not documented and remain best-effort; contributions with anonymized real responses welcome.

- Docs: <https://yalidine.app/app/dev/docs/api/> (account required)
- Base URL: `https://api.yalidine.app/v1/` (paths below are relative to it; keep the trailing `/` on collection endpoints)

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
| `isStopDesk` / `stopDeskId` | `is_stopdesk` / `stopdesk_id` | |
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

### Implementation notes (TS `packages/ts/src/providers/yalidine.ts`)

Same mapping as above, plus:

- Wilaya ids/codes/names are always resolved through the cached `wilayas/` list (so `getFees` / `getCommunes` / `createParcel` make one extra call on a fresh client). Unknown wilaya or commune → `NOT_FOUND` before the parcel is posted.
- Phone numbers that are not valid Algerian numbers → `VALIDATION_ERROR` before any HTTP call. Missing `fromWilayaId` / `fromWilayaName` is also checked before any HTTP call.
- `histories/` pagination is followed when `has_more` is `true` (PHP reads the first page only, with `page_size=1000`).
- A parcel lookup that returns empty `data` throws `NOT_FOUND` without `httpStatus` (the HTTP call itself returned `200`).
- Confirmed by the docs: list endpoints accept `page` / `page_size`; `contact_phone` accepts comma-separated numbers; `freeshipping: true` = the sender pays the delivery fee; `stopdesk_id` is a `center_id` from `centers/`.
- Still to confirm with real responses: error body format; whether Yalidine rounds the overweight kg.

---

## Maystro Delivery

> Built from the public API docs (saved in [`vendor/maystro/maystro-api-full.md`](./vendor/maystro/maystro-api-full.md)) on 2026-10-20. No sandbox response has been captured yet: fixtures are derived from the doc examples.

- Docs: <https://maystro.gitbook.io/maystro-delivery-documentation/reference/maystro-delivery-api-reference>
- Base URL: `https://orders-management.maystro-delivery.com` (paths below are absolute; keep the trailing `/` on `api/base/...` endpoints)

### Auth

| Header | Value | Config key |
|--------|-------|------------|
| `Authorization` | `Token <token>` | `apiToken` (`MAYSTRO_API_TOKEN`) |
| `Accept` / `Content-Type` | `application/json` | — |

> **Assumption:** the orders page literally says `Authorization: token` ("replace `<token>` with your token"), while the webhook pages say `token <store token>`. The API is Django REST Framework, whose `TokenAuthentication` expects `Token <key>`, so the SDK sends `Authorization: Token <apiToken>`. A token that already starts with `Token ` is sent unchanged.

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST /api/orders` | Body is a **list** of orders (bulk, we send one). Response: `[{ id, external_id, tracking, success, delivery_price, errors: [] }]`. `success: false` or non-empty `errors` → `ShippingError` (see Errors). No follow-up read (no read endpoint): status is always `pending`. |
| `track` | — | **Not supported** (`NOT_SUPPORTED`, no HTTP call). Maystro documents no order read/tracking endpoint; status changes are pushed by webhooks (`OrderStatusChanged`, `payload.status` = numeric code). Map them with `mapMaystroStatus` (TS) / `StatusMapper::maystro()` (PHP). |
| `getFees` | `GET /api/base/delivery-options/?commune=` | One call returns home, stop-desk and pickup-point prices (see Fees). `GET /api/base/delivery-prices/?commune=&delivery_type=` returns one mode only and is not used. |
| `getWilayas` | `GET /api/base/wilayas/?language=fr&country=1` | Response is a list of `[id, name]` pairs (objects `{ id, name }` are also accepted). Wilaya `id` **is** the official code. Not paginated. |
| `getCommunes` | `GET /api/base/communes/?wilaya=<id>` | Response: `[{ id, wilaya, name, postcode, zone }]`. A DRF page `{ results: [...] }` is also accepted (first page only). |
| `getStopDesks` | `GET /api/base/pickup-points?commune=<id>` | **`communeId` required** (`VALIDATION_ERROR` otherwise). Response `[{ name_lt, name_ar, commune, pickup_point, delivery_type, active }]`. Stop desk (`delivery_type: 2`, `pickup_point: null`) → `id` = commune id; pickup point (`delivery_type: 3`) → `id` = `pickup_point`. `active: false` skipped. |
| `cancelParcel` | — | **Not supported** (`NOT_SUPPORTED`, no HTTP call): no documented cancellation endpoint. |
| `healthCheck` | `GET /api/base/wilayas/` | Same probe as `getWilayas`, but **always** hits the network (cache bypassed). |

### `ParcelInput` → `POST /api/orders` body

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
| `status` | always `pending` (the response has no status; new orders start as `4` / `created`) |
| `provider` | `"maystro"` |

### Locations → `Location`

| Unified | Wilaya (`[id, name]`) | Commune |
|---------|------------------------|---------|
| `id` | `id` | `id` |
| `name` | `name` (French, `language=fr`) | `name` |
| `parentId` | — | `wilaya` |
| `code` | `id` (official code) | `postcode` |

### Fees → `FeeQuote`

`GET /api/base/delivery-options/?commune=` response: `[{ type: "home" | "stopdesk" | "pickup", name, price, min_total_price, required_points, current_points, pickup_point_id? }]`.

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
- Auth header format `Token <token>` (see Auth).
- Wilaya ids are assumed to equal the official codes `1`–`58` (true for every id in the docs example), so `code = id`.
- Error entry shape (`40` vs `{ code, message }`) and non-order error bodies are not documented (see Errors).
- Bulk create, exchanges, refunds, products/stock, pickup points listing, order slips and webhook management are out of MVP scope.

---

## Ecotrack

> Ecotrack is not a courier but a white-label platform: DHD, Conexlog, Anderson, MSM Go, Packers, World Express and ~80 other couriers expose the **same API** on their own domain. One provider (`ecotrack`) serves all of them; the tenant is chosen with `courier` or `baseUrl`.
> Built from third-party integration notes on the official Postman collection (`docs/vendor/ecotrack/`, private). Needs confirmation with real responses per tenant.

- Base URL: `https://<tenant>/api/v1` (paths below are relative to it). Single-order endpoints take **query parameters**, never a JSON body.

### Auth / tenant

| Option | Value | Notes |
|--------|-------|-------|
| `token` | API token from the courier's dashboard | Sent as `Authorization: Bearer <token>` (a `Bearer ` prefix in the value is stripped). |
| `courier` | built-in tenant key | Exactly one of `courier` / `baseUrl`. Unknown key → `VALIDATION_ERROR`. |
| `baseUrl` | tenant URL, e.g. `https://xyz.ecotrack.dz` | Must be `https`; a trailing `/api/v1` is stripped. |
| `autoValidate` | `false` (default) | `true` → `POST valid/order` right after creation, so the courier picks the order up. |

Built-in `courier` keys (hosts from the integration notes, not all confirmed by the couriers — use `baseUrl` if yours differs):

| Key | Host |
|-----|------|
| `dhd` | `https://platform.dhd-dz.com` |
| `conexlog` | `https://app.conexlog-dz.com` |
| `andersondelivery` | `https://andersondelivery.ecotrack.dz` |
| `msmgo` | `https://msmgo.ecotrack.dz` |
| `packers` | `https://packers.ecotrack.dz` |
| `rocketdelivery` | `https://rocketdelivery.ecotrack.dz` |
| `worldexpress` | `https://worldexpress.ecotrack.dz` |

### Method mapping

| Unified method | Native endpoint | Notes |
|----------------|-----------------|-------|
| `createParcel` | `POST create/order?…` | Query parameters (below). Returns `{ success, tracking }`. With `autoValidate`, followed by `POST valid/order?tracking=`; a validation failure says the order *was created*. |
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

---

## Adding a provider

Copy the ZRExpress section structure (Auth, Method mapping, Field mapping, Status mapping, Errors) and see [`CONTRIBUTING.md`](../CONTRIBUTING.md#how-to-add-a-provider).
