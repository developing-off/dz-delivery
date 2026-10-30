/**
 * Shared contract types — see docs/CONTRACT.md (v0.1).
 * Do not add fields here without updating the contract first.
 */

export type ParcelStatus =
  | 'pending'
  | 'created'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'cancelled'
  | 'unknown';

export const PARCEL_STATUSES: readonly ParcelStatus[] = [
  'pending',
  'created',
  'in_transit',
  'delivered',
  'returned',
  'cancelled',
  'unknown',
];

/** ZRExpress `orderedProducts[].stockType`. Other carriers ignore it. */
export type StockType = 'none' | 'local' | 'warehouse';

export interface ProductItem {
  name: string;
  quantity: number;
  unitPrice?: number;
  sku?: string;
  /** Carrier catalog product id (ZRExpress when `stockType` is `local` / `warehouse`). */
  productId?: string;
  /** Per-item stock mode; overrides `ParcelInput.stockType` when set. */
  stockType?: StockType;
}

export interface ParcelInput {
  recipientName: string;
  phone: string;
  phone2?: string;
  address: string;
  wilayaId?: string | number;
  wilayaName?: string;
  communeId?: string | number;
  communeName?: string;
  productName?: string;
  productList?: ProductItem[];
  /** Amount to collect from the recipient (COD), in DZD. `0` for prepaid. */
  price: number;
  /** kg */
  weight?: number;
  /** cm */
  length?: number;
  /** cm */
  width?: number;
  /** cm */
  height?: number;
  isStopDesk?: boolean;
  stopDeskId?: string;
  remark?: string;
  orderId?: string;
  /**
   * Default stock mode for products that omit `ProductItem.stockType`.
   * ZRExpress only (`orderedProducts[].stockType`); default when omitted: `"none"`.
   */
  stockType?: StockType;
}

export interface Parcel {
  id: string;
  trackingNumber: string;
  status: ParcelStatus;
  provider: string;
  raw?: unknown;
}

/** Input to `listParcels` (CONTRACT.md §2.11). */
export interface ParcelListQuery {
  /** 1-based. Default `1`. */
  page?: number;
  /** Default `50`. Carriers MAY clamp (ZRExpress ≤ 1000). */
  pageSize?: number;
  /** Free-text search (tracking, customer name, phone…). */
  keyword?: string;
  /** Merchant order reference (`ParcelInput.orderId`). */
  orderId?: string;
  /** Unified status filter (often applied after mapping). */
  status?: ParcelStatus;
  /** ISO 8601 — parcels updated at/after this instant when supported. */
  updatedSince?: string;
  /** Follow `hasNext` and merge pages (safety-capped). Default `false`. */
  allPages?: boolean;
}

/** Result of `listParcels` (CONTRACT.md §2.12). */
export interface ParcelListPage {
  parcels: Parcel[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasNext: boolean;
  raw?: unknown;
}

export interface TrackingEvent {
  status: ParcelStatus;
  label: string;
  /** ISO 8601 */
  at: string;
  raw?: unknown;
}

export interface TrackResult {
  parcel: Parcel;
  /** Oldest first. */
  events: TrackingEvent[];
}

export interface FeeQuery {
  toWilayaId: string | number;
  toCommuneId?: string | number;
  fromWilayaId?: string | number;
  weight?: number;
  /** Package dimensions in cm, for carriers that bill volumetric weight. */
  length?: number;
  width?: number;
  height?: number;
  isStopDesk?: boolean;
}

export interface FeeQuote {
  deliveryFee: number;
  returnFee?: number;
  stopDeskFee?: number;
  currency: 'DZD';
  raw?: unknown;
}

export interface Location {
  id: string;
  name: string;
  parentId?: string;
  code?: string;
  raw?: unknown;
}

export interface StopDeskQuery {
  /** Wilaya (provider `Location.id`, official code `1`–`58`, or name). */
  wilayaId: string | number;
  /**
   * Commune (provider `Location.id` or name). Required by some carriers (Maystro).
   * Optional filter elsewhere — for ZRExpress prefer wilaya-only first (many hubs
   * are not tagged with a district; empty commune results throw `NOT_FOUND` with a hint
   * when the wilaya still has hubs).
   */
  communeId?: string | number;
}

export interface StopDesk {
  /** Value to pass as `ParcelInput.stopDeskId`. */
  id: string;
  name: string;
  address?: string;
  communeId?: string;
  wilayaId?: string;
  /** Primary phone when the carrier returns it. */
  phone?: string;
  /** Opening hours text when available. */
  openingHours?: string;
  lat?: number;
  lng?: number;
  /** Carrier hub/desk type label when exposed (e.g. ZRExpress `"stopdesk"`). */
  type?: string;
  raw?: unknown;
}

/** Result of `healthCheck()` — CONTRACT.md §5. Failures throw `ShippingError` instead. */
export interface HealthCheckResult {
  ok: true;
  provider: string;
  /** Round-trip duration in milliseconds. */
  latencyMs: number;
}

export type ShippingErrorCode =
  | 'AUTH_FAILED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NOT_SUPPORTED'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface ShippingErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

/** Options shared by every provider (CONTRACT.md §6). */
export interface BaseClientConfig {
  /** Override the API base URL (sandbox, proxy, tests). */
  baseUrl?: string;
  /** HTTP timeout in ms. Default `15000`. */
  timeoutMs?: number;
  /** Populate `raw` fields. Default `true`. */
  includeRaw?: boolean;
  /** Custom `fetch` implementation (tests, proxies, older runtimes). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface ZRExpressConfig extends BaseClientConfig {
  apiKey: string;
  tenant: string;
}

export interface YalidineConfig extends BaseClientConfig {
  apiId: string;
  apiToken: string;
  /**
   * Origin wilaya of your parcels (Yalidine id = official code `1`–`58`).
   * Yalidine needs an origin for `createParcel` (`from_wilaya_name`); it is also the
   * default `fromWilayaId` for `getFees`. Set this or `fromWilayaName`.
   */
  fromWilayaId?: string | number;
  /** Origin wilaya by name (case/accent-insensitive), alternative to `fromWilayaId`. */
  fromWilayaName?: string;
}

export interface MaystroConfig extends BaseClientConfig {
  /** Store token, sent as `Authorization: Token <apiToken>`. */
  apiToken: string;
}

export interface EcotrackConfig extends BaseClientConfig {
  /** API token from the courier's dashboard, sent as `Authorization: Bearer <token>`. */
  token: string;
  /**
   * Tenant URL of the courier, e.g. `https://dhd.ecotrack.dz` (`/api/v1` is appended).
   * Exactly one of `baseUrl` / `courier` is required. Must be `https`.
   */
  baseUrl?: string;
  /** Built-in tenant key instead of `baseUrl`, e.g. `'dhd'`, `'conexlog'` (see `ECOTRACK_COURIERS`). */
  courier?: string;
  /**
   * Validate each order right after creation (`POST valid/order`), so the courier picks it up.
   * Default `false`: orders wait as `pending` until validated from the courier's dashboard.
   */
  autoValidate?: boolean;
}

export interface NoestConfig extends BaseClientConfig {
  /** API token from the NOEST partner dashboard, sent as `Authorization: Bearer <apiToken>`. */
  apiToken: string;
  /** Partner GUID from the NOEST partner dashboard (`user_guid`). */
  userGuid: string;
  /**
   * Validate each order right after creation (`POST valid/order`), so NOEST picks it up.
   * Default `false`: orders wait as `pending` (still editable) until validated.
   */
  autoValidate?: boolean;
}

export interface EcomConfig extends BaseClientConfig {
  /** `KEY` from the E-com developer page, sent as `X-API-Key`. */
  apiKey: string;
  /** `Token` from the same page (regenerable), sent as `X-API-Token`. */
  apiToken: string;
  /**
   * Create parcels already confirmed (`confirmee: 1`, "En Traitement"), so E-com picks them up.
   * Default `false`: parcels stay `pending` ("En Préparation", still editable) until confirmed.
   */
  autoValidate?: boolean;
}

export interface ProviderConfigMap {
  zrexpress: ZRExpressConfig;
  yalidine: YalidineConfig;
  maystro: MaystroConfig;
  ecotrack: EcotrackConfig;
  noest: NoestConfig;
  ecom: EcomConfig;
}

export type ProviderName = keyof ProviderConfigMap;
