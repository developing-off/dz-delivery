/**
 * Maystro Delivery provider.
 *
 * Built from the public API docs (docs/vendor/maystro/maystro-api-full.md; mapping in
 * docs/PROVIDERS.md#maystro-delivery):
 *
 * - Orders / locations: `https://orders-management.maystro-delivery.com`; live fees:
 *   `https://backend.maystro-delivery.com` (`MAYSTRO_BACKEND_BASE_URL`). Auth header
 *   `Authorization: Token <token>` (assumed Django REST convention, see PROVIDERS.md).
 * - Orders are created in bulk (`POST /api/orders/` takes a list); each result row carries
 *   `success` and numeric `errors` codes.
 * - Wilaya ids are the official codes `1`–`58`; wilayas come back as `[id, name]` pairs.
 * - Orders are read, listed and cancelled on the backend host (`/api/stores/orders/`,
 *   `/api/shared/status/{id}/`); their status history is on `https://b.maystro-delivery.com`
 *   (`/api/stores/history_order/{id}`). These calls take the order UUID (`Parcel.id`) or the
 *   tracking number (the order `display_id`, looked up with `?display_id=`).
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper, normalizeStatusKey } from '../status';
import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  MaystroConfig,
  Parcel,
  ParcelInput,
  ParcelListPage,
  ParcelListQuery,
  ParcelStatus,
  ShippingErrorCode,
  ShippingErrorDetail,
  StopDesk,
  StopDeskQuery,
  TrackingEvent,
  TrackResult,
} from '../types';
import { PARCEL_STATUSES } from '../types';
import {
  findLocationByName,
  isRecord,
  normalizeAlgerianPhone,
  sortEventsAscending,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

export const MAYSTRO_DEFAULT_BASE_URL = 'https://orders-management.maystro-delivery.com';
/** Live tariffs host used by Confirmation-api (`getDeliveryPrice`). Orders stay on `MAYSTRO_DEFAULT_BASE_URL`. */
export const MAYSTRO_BACKEND_BASE_URL = 'https://backend.maystro-delivery.com';
/** Host of the order history endpoint (`/api/stores/history_order/{id}`), as documented by Maystro. */
export const MAYSTRO_HISTORY_BASE_URL = 'https://b.maystro-delivery.com';
const PROVIDER = 'maystro';

/** Maystro serves a fixed 20 orders per page on `GET /api/stores/orders/`. */
const LIST_PAGE_SIZE = 20;
const LIST_MAX_PAGES = 100;
/** `PATCH /api/shared/status/{id}/` body that aborts an order (docs: status 50, abort_reason 21). */
const STATUS_ABORTED = 50;
const ABORT_REASON = 21;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Orders per `getLabels` call (keeps the generated PDF and the request reasonable). */
const LABELS_MAX = 100;

/** Maystro extra: shipping labels (bordereaux) as one PDF, a page per order found. */
export interface MaystroLabels {
  contentType: 'application/pdf';
  /** PDF bytes: write them to a file or send them as the HTTP response body. */
  data: Uint8Array;
  /** Labels in the PDF. Lower than the references sent when some were not found. */
  labelCount: number;
}

/**
 * Pages of a Maystro label PDF that carry a label. Each label page embeds its barcode as an
 * image; the blank page Maystro returns when no order matched has none (checked live).
 */
function countPdfLabels(pdf: string): number {
  if (!/\/Subtype\s*\/Image/.test(pdf)) return 0;
  return (pdf.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

const DELIVERY_HOME = 1;
const DELIVERY_STOP_DESK = 2;
const DELIVERY_PICKUP_POINT = 3;

/** Native status code → native status name (Maystro "Status Code REF"). */
export const MAYSTRO_STATUS_CODES: Readonly<Record<number, string>> = {
  4: 'CREATED',
  5: 'PICK_UP_REQUESTED',
  6: 'IN_PROCESS',
  8: 'WAITING_TRANSIT',
  9: 'IN_TRANSIT_TO_BE_SHIPPED',
  10: 'IN_TRANSIT_TO_BE_RETURNED',
  11: 'PENDING',
  12: 'OUT_OF_STOCK',
  15: 'READY_TO_SHIP',
  22: 'ASSIGNED',
  31: 'SHIPPED',
  32: 'ALERTED',
  41: 'DELIVERED',
  42: 'POSTPONED',
  50: 'ABORTED',
  51: 'READY_TO_RETURN',
  52: 'TAKEN_BY_STORE',
  53: 'NOT_RECEIVED',
};

const mapMaystroStatusName = createStatusMapper({
  exact: {
    CREATED: 'pending',
    PENDING: 'pending',
    OUT_OF_STOCK: 'pending',
    PICK_UP_REQUESTED: 'created',
    IN_PROCESS: 'created',
    WAITING_TRANSIT: 'in_transit',
    IN_TRANSIT_TO_BE_SHIPPED: 'in_transit',
    READY_TO_SHIP: 'in_transit',
    ASSIGNED: 'in_transit',
    SHIPPED: 'in_transit',
    ALERTED: 'in_transit',
    POSTPONED: 'in_transit',
    DELIVERED: 'delivered',
    ABORTED: 'cancelled',
    CANCELLED: 'cancelled',
    CANCELED: 'cancelled',
    IN_TRANSIT_TO_BE_RETURNED: 'returned',
    READY_TO_RETURN: 'returned',
    READY_TO_BE_RETURNED: 'returned',
    TAKEN_BY_STORE: 'returned',
    NOT_RECEIVED: 'returned',
  },
});

/**
 * Maystro status (numeric code such as `41` / `"41"`, or name such as `"DELIVERED"`) →
 * unified status. Meant for webhook payloads (`payload.status`). MUST stay identical to
 * the PHP `StatusMapper::maystro` (enforced by docs/fixtures/maystro/statuses.json).
 */
export function mapMaystroStatus(native: string | number | null | undefined): ParcelStatus {
  if (typeof native === 'number') return Number.isInteger(native) ? mapMaystroStatusName(MAYSTRO_STATUS_CODES[native]) : 'unknown';
  if (typeof native !== 'string') return 'unknown';
  const value = native.trim();
  if (/^\d+$/.test(value)) return mapMaystroStatusName(MAYSTRO_STATUS_CODES[Number(value)]);
  return mapMaystroStatusName(value);
}

/** Order error code → [unified code, message, ParcelInput field]. Messages from the docs' "Error Mappings". */
const ORDER_ERRORS: Record<number, [ShippingErrorCode, string, string?]> = {
  10: ['VALIDATION_ERROR', 'Order price is not valid or it was not defined', 'price'],
  20: ['VALIDATION_ERROR', 'Order address is not defined', 'address'],
  30: ['VALIDATION_ERROR', 'Order customer information (name/phone) is not valid or was not defined', 'phone'],
  40: ['NOT_FOUND', 'Order wilaya or commune do not exist or they were not defined', 'communeId'],
  45: ['VALIDATION_ERROR', 'Order delivery type does not exist for the provided commune', 'isStopDesk'],
  50: ['VALIDATION_ERROR', 'Order products are missing, inconsistent or not valid', 'productList'],
  55: ['VALIDATION_ERROR', 'Duplicated order (same customer name/phone in the last 24 hours)'],
  60: ['PROVIDER_ERROR', 'Unexpected Maystro error (contact Maystro support)'],
  70: ['PROVIDER_ERROR', 'Maystro could not determine the delivery price (contact Maystro support)'],
  80: ['VALIDATION_ERROR', 'Orders list is empty'],
  90: ['VALIDATION_ERROR', 'Too many orders in one request'],
  100: ['VALIDATION_ERROR', 'Order external ID exceeds 100 characters', 'orderId'],
  101: ['VALIDATION_ERROR', 'Cannot pay the delivery price with points (not enough points)'],
};

interface OrderErrorSummary {
  code: ShippingErrorCode;
  message: string;
  details: ShippingErrorDetail[];
}

/**
 * `errors` of a rejected order row → unified error. Entries may be bare codes (`40`)
 * or objects (`{ code, message }`); the first known code decides the unified code.
 */
function summarizeOrderErrors(errors: unknown): OrderErrorSummary {
  const details: ShippingErrorDetail[] = [];
  let code: ShippingErrorCode | undefined;
  for (const entry of Array.isArray(errors) ? errors : []) {
    let nativeCode: unknown;
    let nativeMessage: string | undefined;
    if (isRecord(entry)) {
      nativeCode = entry.code ?? entry.error_code;
      nativeMessage = str(entry.message ?? entry.detail);
    } else if (typeof entry === 'string' && !/^\d+$/.test(entry.trim())) {
      nativeMessage = entry;
    } else {
      nativeCode = entry;
    }
    const known = hasValue(nativeCode) ? ORDER_ERRORS[Number(nativeCode)] : undefined;
    code ??= known?.[0];
    const detail: ShippingErrorDetail = {
      message: nativeMessage || known?.[1] || (hasValue(nativeCode) ? `Maystro error code ${String(nativeCode)}` : 'Maystro rejected the order'),
    };
    if (known?.[2]) detail.field = known[2];
    if (hasValue(nativeCode)) detail.code = String(nativeCode).trim();
    details.push(detail);
  }
  return {
    code: code ?? 'VALIDATION_ERROR',
    message: details.length > 0 ? details.map((d) => d.message).join('; ') : 'Maystro rejected the order',
    details,
  };
}

function isOrderRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ('errors' in value || 'success' in value);
}

const parseMaystroError: ErrorBodyParser = (body) => {
  if (Array.isArray(body) && isOrderRow(body[0])) {
    const { message, details } = summarizeOrderErrors(body[0].errors);
    return { message, details };
  }
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : undefined;
  const message = str(body.detail) ?? str(body.message) ?? (typeof body.error === 'string' ? body.error : undefined);
  const details: ShippingErrorDetail[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (field === 'detail' || field === 'message' || field === 'error') continue;
    const messages = Array.isArray(value) ? value : [value];
    for (const m of messages) if (typeof m === 'string') details.push({ field, message: m });
  }
  return { message: message ?? details.map((d) => d.message).join('; '), details };
};

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * `GET /api/stores/orders/` page → rows. The docs wrap the DRF page in `list`
 * (`{ list: { count, next, previous, results } }`); a bare DRF page or a plain array is accepted too.
 */
function ordersPage(body: unknown): { items: Record<string, unknown>[]; count?: number; hasNext?: boolean } {
  const pageBody = isRecord(body) && isRecord(body.list) ? body.list : body;
  if (Array.isArray(pageBody)) return { items: pageBody.filter(isRecord) };
  if (!isRecord(pageBody) || !Array.isArray(pageBody.results)) {
    throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro orders response', { provider: PROVIDER, raw: body });
  }
  return {
    items: pageBody.results.filter(isRecord),
    count: num(pageBody.count),
    hasNext: 'next' in pageBody ? hasValue(pageBody.next) : undefined,
  };
}

/** Numeric strings → numbers (Maystro ids are integers), anything else unchanged. */
function idValue(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export class MaystroProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  /** Same token as `http`, pointed at `MAYSTRO_BACKEND_BASE_URL` for live `delivery_price`. */
  private readonly backendHttp: HttpClient;
  /** Same token, pointed at `MAYSTRO_HISTORY_BASE_URL` for the order history. */
  private readonly historyHttp: HttpClient;
  private readonly includeRaw: boolean;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<Location[]>>();

  constructor(config: MaystroConfig) {
    const token = config?.apiToken?.trim();
    if (!token) {
      throw new ShippingError('AUTH_FAILED', 'Maystro requires `apiToken`', { provider: PROVIDER });
    }
    this.includeRaw = config.includeRaw ?? true;
    const headers = {
      Authorization: /^token\s/i.test(token) ? token : `Token ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const shared = {
      provider: PROVIDER,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseMaystroError,
      headers,
    };
    this.http = new HttpClient({
      ...shared,
      baseUrl: config.baseUrl ?? MAYSTRO_DEFAULT_BASE_URL,
    });
    this.backendHttp = new HttpClient({
      ...shared,
      baseUrl: MAYSTRO_BACKEND_BASE_URL,
    });
    this.historyHttp = new HttpClient({
      ...shared,
      baseUrl: MAYSTRO_HISTORY_BASE_URL,
    });
  }

  /**
   * `POST /api/orders/` with a one-element list. The wilaya is sent by name and the
   * commune by id, both resolved (and checked) through the cached location lists.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const phone2 = input.phone2 ? normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2') : undefined;

    const wilaya = await this.resolveWilaya(input.wilayaId ?? input.wilayaName!);
    const commune = await this.resolveCommune(wilaya, input.communeId ?? input.communeName!);

    const products = input.productList?.length
      ? input.productList.map((p) => ({ product: p.sku?.trim() || '', description: p.name.trim(), quantity: p.quantity }))
      : [{ product: '', description: input.productName!.trim(), quantity: 1 }];

    const order: Record<string, unknown> = {
      customer_name: input.recipientName.trim(),
      customer_phone: phone,
      destination_text: input.address.trim(),
      // `total_price` includes the delivery fee: it is exactly what the recipient pays.
      total_price: Math.round(input.price),
      wilaya: wilaya.name,
      commune: idValue(commune.id),
      delivery_type: DELIVERY_HOME,
      express: false,
      details: products,
    };
    if (phone2) order.customer_phone2 = phone2;
    if (input.remark?.trim()) order.note_to_driver = input.remark.trim();
    if (input.orderId?.trim()) order.external_id = input.orderId.trim();
    if (input.isStopDesk) {
      const desk = String(input.stopDeskId).trim();
      if (desk === commune.id) {
        order.delivery_type = DELIVERY_STOP_DESK;
      } else {
        order.delivery_type = DELIVERY_PICKUP_POINT;
        order.pickup_point = idValue(desk);
      }
    }

    // Trailing slash matches the live orders-management URL used by Delivery/MaystroController.
    const res = await this.http.request<unknown>({ method: 'POST', path: '/api/orders/', body: [order] });
    const row = Array.isArray(res.body) ? res.body[0] : res.body;
    if (!isOrderRow(row)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro create response', { provider: PROVIDER, raw: res.body });
    }
    if (row.success !== true || (Array.isArray(row.errors) && row.errors.length > 0)) {
      const { code, message, details } = summarizeOrderErrors(row.errors);
      throw new ShippingError(code, message, { provider: PROVIDER, details, raw: res.body });
    }
    if (!hasValue(row.tracking)) {
      throw new ShippingError('PROVIDER_ERROR', 'Maystro did not return a tracking number', { provider: PROVIDER, raw: res.body });
    }

    // The response carries no status; new orders start as CREATED (4) → `pending`.
    const tracking = String(row.tracking);
    return withRaw(
      { id: hasValue(row.id) ? String(row.id) : tracking, trackingNumber: tracking, status: 'pending' as const, provider: PROVIDER },
      row,
      this.includeRaw,
    );
  }

  /**
   * Order (`GET {backend}/api/stores/orders/{id}/`) + status history
   * (`GET {b}/api/stores/history_order/{id}`, oldest first). `trackingNumber` is the order
   * UUID (`Parcel.id` from `createParcel`) or its `display_id` (the tracking number `createParcel` returns).
   */
  async track(trackingNumber: string): Promise<TrackResult> {
    const ref = trackingNumber?.trim();
    if (!ref) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const order = await this.resolveOrder(ref);
    const orderId = String(order.id);
    const { body } = await this.historyHttp.request<unknown>({
      method: 'GET',
      path: `/api/stores/history_order/${encodeURIComponent(orderId)}`,
    });
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.results) ? body.results : undefined;
    if (!rows) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro order history response', { provider: PROVIDER, raw: body });
    }
    const events: TrackingEvent[] = rows.filter(isRecord).map((row) => {
      const code = row.status;
      const name = typeof code === 'number' || (typeof code === 'string' && /^\d+$/.test(code.trim()))
        ? MAYSTRO_STATUS_CODES[Number(code)]
        : str(code);
      const base = name ?? (hasValue(code) ? String(code).trim() : '');
      const comment = str(row.comment);
      const label = base && comment ? `${base} (${comment})` : base || comment || '';
      return withRaw(
        { status: mapMaystroStatus(code as string | number | null | undefined), label, at: toIsoDate(str(row.created_at) ?? '') },
        row,
        this.includeRaw,
      );
    });

    return { parcel: this.toParcel(order), events: sortEventsAscending(events) };
  }

  /**
   * Prices are per commune: without `toCommuneId`, the first commune of the wilaya is used.
   * Prefers Confirmation's live host: `GET {backend}/api/stores/delivery_price/?commune=&delivery_type=&express=false`
   * (`delivery_type` 1 = home, 2 = stop desk). On `NOT_FOUND` / `NETWORK_ERROR` (wrong host or
   * unavailable), falls back to orders-management `delivery-options` then `delivery-prices`.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }

    let communeId: string;
    if (hasValue(query.toCommuneId)) {
      communeId = String(query.toCommuneId).trim();
    } else {
      const wilaya = await this.resolveWilaya(query.toWilayaId);
      const first = (await this.communesOf(wilaya.id))[0];
      if (!first) throw new ShippingError('NOT_FOUND', `No Maystro commune in wilaya ${wilaya.name}`, { provider: PROVIDER });
      communeId = first.id;
    }

    const isStopDesk = query.isStopDesk === true;

    try {
      return await this.feeQuoteFromStoresPrice(communeId, isStopDesk);
    } catch (err) {
      if (!(err instanceof ShippingError) || (err.code !== 'NOT_FOUND' && err.code !== 'NETWORK_ERROR')) throw err;
    }

    try {
      const res = await this.http.request<unknown>({
        method: 'GET',
        path: '/api/base/delivery-options/',
        query: { commune: communeId },
      });
      if (Array.isArray(res.body)) {
        return this.feeQuoteFromOptions(res.body, isStopDesk, res.body);
      }
    } catch (err) {
      if (!(err instanceof ShippingError) || err.code !== 'NOT_FOUND') throw err;
    }

    return this.feeQuoteFromPrices(communeId, isStopDesk);
  }

  /** Confirmation-api live tariffs: `backend.maystro-delivery.com/api/stores/delivery_price/`. */
  private async feeQuoteFromStoresPrice(communeId: string, isStopDesk: boolean): Promise<FeeQuote> {
    const homeBody = await this.storesDeliveryPrice(communeId, DELIVERY_HOME);
    const deskBody = await this.storesDeliveryPriceOrNull(communeId, DELIVERY_STOP_DESK);
    const home = num(homeBody.delivery_price);
    const desk = deskBody ? num(deskBody.delivery_price) : undefined;
    const deliveryFee = isStopDesk ? desk : home;
    const raw = { home: homeBody, stopdesk: deskBody };
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', 'No Maystro rate for this delivery type', { provider: PROVIDER, raw });
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, raw, this.includeRaw);
  }

  private async storesDeliveryPrice(communeId: string, deliveryType: number): Promise<Record<string, unknown>> {
    const res = await this.backendHttp.request<unknown>({
      method: 'GET',
      path: '/api/stores/delivery_price/',
      query: { commune: communeId, delivery_type: deliveryType, express: false },
    });
    if (!isRecord(res.body) || !('delivery_price' in res.body)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro stores/delivery_price response', {
        provider: PROVIDER,
        raw: res.body,
      });
    }
    return res.body;
  }

  private async storesDeliveryPriceOrNull(communeId: string, deliveryType: number): Promise<Record<string, unknown> | null> {
    try {
      return await this.storesDeliveryPrice(communeId, deliveryType);
    } catch (err) {
      if (err instanceof ShippingError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  private feeQuoteFromOptions(native: unknown[], isStopDesk: boolean, raw: unknown): FeeQuote {
    const priceOf = (type: string) => {
      const option = native.find((o) => isRecord(o) && normalizeStatusKey(String(o.type ?? '')) === type);
      return isRecord(option) ? num(option.price ?? option.delivery_price) : undefined;
    };
    const home = priceOf('home');
    const desk = priceOf('stopdesk') ?? priceOf('pickup');
    const deliveryFee = isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', 'No Maystro rate for this delivery type', { provider: PROVIDER, raw });
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, raw, this.includeRaw);
  }

  private async feeQuoteFromPrices(communeId: string, isStopDesk: boolean): Promise<FeeQuote> {
    const homeBody = await this.deliveryPrice(communeId, DELIVERY_HOME);
    const deskBody =
      (await this.deliveryPriceOrNull(communeId, DELIVERY_STOP_DESK)) ??
      (await this.deliveryPriceOrNull(communeId, DELIVERY_PICKUP_POINT));
    const home = num(homeBody.delivery_price);
    const desk = deskBody ? num(deskBody.delivery_price) : undefined;
    const deliveryFee = isStopDesk ? desk : home;
    const raw = { home: homeBody, stopdesk: deskBody };
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', 'No Maystro rate for this delivery type', { provider: PROVIDER, raw });
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, raw, this.includeRaw);
  }

  private async deliveryPrice(communeId: string, deliveryType: number): Promise<Record<string, unknown>> {
    const res = await this.http.request<unknown>({
      method: 'GET',
      path: '/api/base/delivery-prices/',
      query: { commune: communeId, delivery_type: deliveryType },
    });
    if (!isRecord(res.body) || !('delivery_price' in res.body)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro delivery-prices response', {
        provider: PROVIDER,
        raw: res.body,
      });
    }
    return res.body;
  }

  private async deliveryPriceOrNull(communeId: string, deliveryType: number): Promise<Record<string, unknown> | null> {
    try {
      return await this.deliveryPrice(communeId, deliveryType);
    } catch (err) {
      if (err instanceof ShippingError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.list('/api/base/wilayas/', { language: 'fr', country: 1 })
      .then((items) =>
        items.flatMap((w) => {
          // Legacy: [id, name]. Current API: { code|display_id|id, name_lt|name, … }.
          const [id, name] = Array.isArray(w)
            ? [w[0], w[1]]
            : isRecord(w)
              ? [w.code ?? w.display_id ?? w.id, w.name_lt ?? w.name ?? w.name_ar]
              : [];
          if (!hasValue(id)) return [];
          return [withRaw({ id: String(id), name: String(name ?? ''), code: String(id) }, w, this.includeRaw)];
        }),
      )
      .catch((err) => {
        this.wilayasCache = undefined;
        throw err;
      });
    return this.wilayasCache;
  }

  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    return this.communesOf((await this.resolveWilaya(wilayaId)).id);
  }

  /**
   * `GET /api/base/pickup-points?commune=` (stop desks and pickup points of one commune, so
   * `communeId` is required). A Maystro stop desk has no id of its own: its `id` is the
   * commune id, which `createParcel` turns into `delivery_type: 2`. Pickup points use their
   * `pickup_point` id (`delivery_type: 3`). Inactive entries are skipped.
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    if (!hasValue(query.communeId)) {
      throw new ShippingError('VALIDATION_ERROR', 'Maystro lists stop desks per commune: communeId is required', {
        provider: PROVIDER,
        details: [{ field: 'communeId', message: 'communeId is required' }],
      });
    }
    const wilaya = await this.resolveWilaya(query.wilayaId);
    const commune = await this.resolveCommune(wilaya, query.communeId!);

    const items = await this.list('/api/base/pickup-points', { commune: commune.id });
    return items.filter(isRecord).flatMap((p) => {
      if (p.active === false) return [];
      const isPickupPoint = Number(p.delivery_type) === DELIVERY_PICKUP_POINT || hasValue(p.pickup_point);
      if (isPickupPoint && !hasValue(p.pickup_point)) return [];
      const desk: StopDesk = {
        id: isPickupPoint ? String(p.pickup_point) : commune.id,
        name: String(p.name_lt ?? p.name_ar ?? p.name ?? ''),
        communeId: hasValue(p.commune) ? String(p.commune) : commune.id,
        wilayaId: wilaya.id,
      };
      return [withRaw(desk, p, this.includeRaw)];
    });
  }

  /**
   * `GET {backend}/api/stores/orders/?page=` (Maystro serves a fixed 20 orders per page, so
   * `pageSize` is always 20). `status`, `orderId` (`external_order_id`), `keyword`
   * (display id, tracking, customer name or phone) and `updatedSince` (order `updated_at`)
   * filter the fetched page client-side: the API has no such query parameters.
   */
  async listParcels(query: ParcelListQuery = {}): Promise<ParcelListPage> {
    const page = query.page ?? 1;
    if (!Number.isInteger(page) || page < 1) {
      throw new ShippingError('VALIDATION_ERROR', 'page must be >= 1', {
        provider: PROVIDER,
        details: [{ field: 'page', message: 'page must be >= 1' }],
      });
    }
    if (query.status !== undefined && !(PARCEL_STATUSES as readonly string[]).includes(query.status)) {
      throw new ShippingError('VALIDATION_ERROR', 'status must be a unified ParcelStatus', {
        provider: PROVIDER,
        details: [{ field: 'status', message: 'status must be a unified ParcelStatus' }],
      });
    }
    if (query.updatedSince !== undefined && Number.isNaN(Date.parse(query.updatedSince))) {
      throw new ShippingError('VALIDATION_ERROR', 'updatedSince must be an ISO 8601 date', {
        provider: PROVIDER,
        details: [{ field: 'updatedSince', message: 'updatedSince must be an ISO 8601 date' }],
      });
    }

    if (query.allPages) {
      const all: Parcel[] = [];
      let totalCount = 0;
      let lastRaw: unknown;
      let hasNext = true;
      for (let n = 1; hasNext && n <= LIST_MAX_PAGES; n += 1) {
        const result = await this.listPage(query, n);
        all.push(...result.parcels);
        if (n === 1) totalCount = result.totalCount;
        lastRaw = result.raw;
        hasNext = result.hasNext;
      }
      // `hasNext` stays true when the page cap cut the walk short.
      return withRaw({ parcels: all, page: 1, pageSize: LIST_PAGE_SIZE, totalCount, hasNext }, lastRaw, this.includeRaw);
    }

    const result = await this.listPage(query, page);
    return withRaw(
      { parcels: result.parcels, page, pageSize: LIST_PAGE_SIZE, totalCount: result.totalCount, hasNext: result.hasNext },
      result.raw,
      this.includeRaw,
    );
  }

  /**
   * `PATCH {backend}/api/shared/status/{id}/` with `{ status: 50, abort_reason: 21 }` (abort).
   * Takes the order UUID (`Parcel.id`) or the tracking number (`display_id`). Unknown order → `NOT_FOUND`;
   * an answer whose `new_status` is not 50 → `VALIDATION_ERROR` (the order was not aborted).
   */
  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const ref = trackingNumberOrId?.trim();
    if (!ref) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });

    const orderId = UUID_RE.test(ref) ? ref : String((await this.resolveOrder(ref)).id);
    const { body } = await this.backendHttp.request<unknown>({
      method: 'PATCH',
      path: `/api/shared/status/${encodeURIComponent(orderId)}/`,
      body: { status: STATUS_ABORTED, abort_reason: ABORT_REASON },
    });
    if (isRecord(body) && hasValue(body.new_status) && Number(body.new_status) !== STATUS_ABORTED) {
      throw new ShippingError('VALIDATION_ERROR', `Maystro did not cancel order ${ref} (status ${String(body.new_status)})`, {
        provider: PROVIDER,
        raw: body,
      });
    }
  }

  /**
   * Maystro extra (not on `ShippingProvider`): the shipping labels (bordereaux) of one or more
   * orders, as one PDF with a page per order.
   *
   * - Tracking numbers (`display_id`) → `POST {backend}/api/delivery/starter/starter_bordureau/`;
   *   order UUIDs (`Parcel.id`) → `POST {backend}/api/delivery/starter/v2/starter_bordureau/`
   *   (`{ orders_ids: [...] }`). A mix is sent as tracking numbers (each UUID costs one order read).
   * - Maystro silently drops unknown references and dedupes repeats: `labelCount` is the number of
   *   labels in the PDF, so `labelCount < references.length` means some were not found. When none
   *   is found Maystro returns a blank page: that throws `NOT_FOUND`.
   */
  async getLabels(references: string[]): Promise<MaystroLabels> {
    const refs = [...new Set((Array.isArray(references) ? references : []).map((r) => String(r ?? '').trim()).filter(Boolean))];
    if (refs.length === 0) {
      throw new ShippingError('VALIDATION_ERROR', 'getLabels requires at least one order reference', {
        provider: PROVIDER,
        details: [{ field: 'references', message: 'at least one tracking number or order id is required' }],
      });
    }
    if (refs.length > LABELS_MAX) {
      throw new ShippingError('VALIDATION_ERROR', `getLabels accepts at most ${LABELS_MAX} orders per call`, {
        provider: PROVIDER,
        details: [{ field: 'references', message: `at most ${LABELS_MAX} orders per call` }],
      });
    }

    const byUuid = refs.every((r) => UUID_RE.test(r));
    const ids = byUuid
      ? refs
      : await Promise.all(
          refs.map(async (r) => (UUID_RE.test(r) ? String((await this.resolveOrder(r)).display_id ?? r) : r)),
        );
    const res = await this.backendHttp.request<Uint8Array>({
      method: 'POST',
      path: byUuid ? '/api/delivery/starter/v2/starter_bordureau/' : '/api/delivery/starter/starter_bordureau/',
      body: { orders_ids: ids },
      // Maystro answers HTTP 406 to `Accept: application/pdf` (checked live); `*/*` gets the PDF.
      headers: { Accept: '*/*' },
      responseType: 'binary',
    });
    const data = res.body;
    const text = new TextDecoder('latin1').decode(data);
    if (!text.startsWith('%PDF')) {
      throw new ShippingError('PROVIDER_ERROR', 'Maystro did not return a PDF label', { provider: PROVIDER, httpStatus: res.status });
    }
    const labelCount = countPdfLabels(text);
    if (labelCount === 0) {
      throw new ShippingError('NOT_FOUND', `No Maystro order found for: ${refs.join(', ')}`, { provider: PROVIDER });
    }
    return { contentType: 'application/pdf', data, labelCount };
  }

  /** Probes `GET /api/base/wilayas/` (bypasses cache). */
  healthCheck(): Promise<HealthCheckResult> {
    return probeWilayasHealth(
      PROVIDER,
      () => {
        this.wilayasCache = undefined;
      },
      () => this.getWilayas(),
    );
  }

  // --- internals -------------------------------------------------------------

  /**
   * Order UUID → `GET {backend}/api/stores/orders/{id}/` (404 → `NOT_FOUND`). A numeric
   * reference is looked up with `GET {backend}/api/stores/orders/?display_id=`.
   */
  private async resolveOrder(ref: string): Promise<Record<string, unknown>> {
    if (UUID_RE.test(ref)) {
      const { body } = await this.backendHttp.request<unknown>({
        method: 'GET',
        path: `/api/stores/orders/${encodeURIComponent(ref)}/`,
      });
      if (!isRecord(body) || !hasValue(body.id)) {
        throw new ShippingError('PROVIDER_ERROR', 'Unexpected Maystro order response', { provider: PROVIDER, raw: body });
      }
      return body;
    }
    if (/^\d+$/.test(ref)) {
      const { body } = await this.backendHttp.request<unknown>({
        method: 'GET',
        path: '/api/stores/orders/',
        query: { display_id: ref },
      });
      const found = ordersPage(body).items.find(
        (o) => hasValue(o.id) && (String(o.display_id ?? '').trim() === ref || String(o.tracking ?? '').trim() === ref),
      );
      if (found) return found;
    }
    throw new ShippingError(
      'NOT_FOUND',
      `Unknown Maystro order: ${ref} (pass Parcel.id or the tracking number returned by createParcel)`,
      { provider: PROVIDER },
    );
  }

  private async listPage(
    query: ParcelListQuery,
    page: number,
  ): Promise<{ parcels: Parcel[]; totalCount: number; hasNext: boolean; raw: unknown }> {
    const { body } = await this.backendHttp.request<unknown>({ method: 'GET', path: '/api/stores/orders/', query: { page } });
    const { items, count, hasNext } = ordersPage(body);
    const orderId = query.orderId?.trim();
    const keyword = query.keyword?.trim().toLowerCase();
    const since = query.updatedSince ? Date.parse(query.updatedSince) : undefined;
    const parcels = items
      .filter((o) => hasValue(o.id))
      .filter((o) => !orderId || String(o.external_order_id ?? '').trim() === orderId)
      .filter((o) => since === undefined || Date.parse(String(o.updated_at ?? '')) >= since)
      .filter(
        (o) =>
          !keyword ||
          [o.display_id, o.tracking, o.customer_name, o.customer_phone, o.external_order_id].some((v) =>
            hasValue(v) ? String(v).toLowerCase().includes(keyword) : false,
          ),
      )
      .map((o) => this.toParcel(o))
      .filter((p) => !query.status || p.status === query.status);
    return {
      parcels,
      totalCount: count ?? (page - 1) * LIST_PAGE_SIZE + items.length,
      hasNext: hasNext ?? items.length === LIST_PAGE_SIZE,
      raw: body,
    };
  }

  /**
   * Order row → `Parcel`. `id` is the order UUID; the tracking number is its `display_id`
   * (the number `createParcel` returns as `tracking`), or `tracking` when a row carries one.
   */
  private toParcel(order: Record<string, unknown>): Parcel {
    const id = String(order.id);
    const trackingNumber = hasValue(order.tracking)
      ? String(order.tracking).trim()
      : hasValue(order.display_id)
        ? String(order.display_id).trim()
        : id;
    return withRaw(
      { id, trackingNumber, status: mapMaystroStatus(order.status as string | number | null | undefined), provider: PROVIDER },
      order,
      this.includeRaw,
    );
  }

  private communesOf(wilayaId: string): Promise<Location[]> {
    let cached = this.communesCache.get(wilayaId);
    if (!cached) {
      cached = this.list('/api/base/communes/', { wilaya: wilayaId })
        .then((items) =>
          items.filter(isRecord).flatMap((c) => {
            if (!hasValue(c.id)) return [];
            const location: Location = {
              id: String(c.id),
              name: String(c.name ?? ''),
              parentId: String(c.wilaya ?? wilayaId),
            };
            if (hasValue(c.postcode)) location.code = String(c.postcode);
            return [withRaw(location, c, this.includeRaw)];
          }),
        )
        .catch((err) => {
          this.communesCache.delete(wilayaId);
          throw err;
        });
      this.communesCache.set(wilayaId, cached);
    }
    return cached;
  }

  /** Plain JSON list (or a DRF `{ results: [...] }` page, first page only). */
  private async list(path: string, query: Record<string, string | number>): Promise<unknown[]> {
    const res = await this.http.request<unknown>({ method: 'GET', path, query });
    const body = res.body;
    const items = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.results) ? body.results : undefined;
    if (!items) {
      throw new ShippingError('PROVIDER_ERROR', `Unexpected Maystro response for ${path}`, { provider: PROVIDER, raw: body });
    }
    return items;
  }

  /** Accepts a Maystro id (= official code `1`–`58`) or a wilaya name. */
  private async resolveWilaya(ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const wilayas = await this.getWilayas();
    const found = /^\d+$/.test(value)
      ? wilayas.find((w) => Number(w.id) === Number(value))
      : findLocationByName(wilayas, value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${value}`, { provider: PROVIDER });
    return found;
  }

  private async resolveCommune(wilaya: Location, ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const communes = await this.communesOf(wilaya.id);
    const found = /^\d+$/.test(value) ? communes.find((c) => c.id === value) : findLocationByName(communes, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilaya.name}`, { provider: PROVIDER });
    }
    return found;
  }
}
