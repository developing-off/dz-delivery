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
 * - There is no documented endpoint to read, track or cancel an order (status updates are
 *   pushed by webhooks only): `track` and `cancelParcel` throw `NOT_SUPPORTED`.
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
  ParcelStatus,
  ShippingErrorCode,
  ShippingErrorDetail,
  StopDesk,
  StopDeskQuery,
  TrackResult,
} from '../types';
import { findLocationByName, isRecord, normalizeAlgerianPhone, str, validateParcelInput, withRaw } from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

export const MAYSTRO_DEFAULT_BASE_URL = 'https://orders-management.maystro-delivery.com';
/** Live tariffs host used by Confirmation-api (`getDeliveryPrice`). Orders stay on `MAYSTRO_DEFAULT_BASE_URL`. */
export const MAYSTRO_BACKEND_BASE_URL = 'https://backend.maystro-delivery.com';
const PROVIDER = 'maystro';

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

/** Numeric strings → numbers (Maystro ids are integers), anything else unchanged. */
function idValue(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export class MaystroProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  /** Same token as `http`, pointed at `MAYSTRO_BACKEND_BASE_URL` for live `delivery_price`. */
  private readonly backendHttp: HttpClient;
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

  /** Not available: Maystro documents no order read/tracking endpoint (webhooks only). */
  async track(_trackingNumber: string): Promise<TrackResult> {
    throw new ShippingError(
      'NOT_SUPPORTED',
      'Maystro has no tracking endpoint; use its webhooks (OrderStatusChanged) with mapMaystroStatus',
      { provider: PROVIDER },
    );
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

  /** Not available: Maystro documents no order cancellation endpoint. */
  async cancelParcel(_trackingNumberOrId: string): Promise<void> {
    throw new ShippingError('NOT_SUPPORTED', 'Maystro has no order cancellation endpoint', { provider: PROVIDER });
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
