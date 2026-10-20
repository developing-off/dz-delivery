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

export interface ProductItem {
  name: string;
  quantity: number;
  unitPrice?: number;
  sku?: string;
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
}

export interface Parcel {
  id: string;
  trackingNumber: string;
  status: ParcelStatus;
  provider: string;
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
  /** Commune (provider `Location.id` or name). Required by some carriers (Maystro). */
  communeId?: string | number;
}

export interface StopDesk {
  /** Value to pass as `ParcelInput.stopDeskId`. */
  id: string;
  name: string;
  address?: string;
  communeId?: string;
  wilayaId?: string;
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

export interface ProviderConfigMap {
  zrexpress: ZRExpressConfig;
  yalidine: YalidineConfig;
  maystro: MaystroConfig;
  ecotrack: EcotrackConfig;
}

export type ProviderName = keyof ProviderConfigMap;
