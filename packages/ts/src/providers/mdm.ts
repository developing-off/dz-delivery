/**
 * MDM provider — `api.mdm.express` (MDM Express shipping API v2).
 *
 * Built from MDM's OpenAPI spec (`/api/docs/swagger`, read 2026-10-30; mapping in
 * docs/PROVIDERS.md#mdm). MDM is a whole e-commerce platform (stock, call center, finance);
 * the provider only uses its "Shipping - Parcels" and geo endpoints:
 *
 * - Auth header `x-api-key`. Parcels belong to a store: `storeId` (`STR-…`) is required to
 *   create one and scopes geo / desk lookups.
 * - Geo ids: wilaya `DZA16`, commune `DZA161601` (`code` `1601`). `Location.id` of a wilaya is
 *   its official code (`16`); communes keep the MDM city id.
 * - Errors share one shape: `{ method, path, status, correlationId, error: { code, message, payload? } }`.
 * - Parcels ship products stocked at MDM: every product line needs its MDM product id
 *   (`ProductItem.productId` or `sku`, `PRD-…`). Free-text products are refused by MDM.
 * - No cancellation endpoint: `cancelParcel` throws `NOT_SUPPORTED`.
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper } from '../status';
import {
  PARCEL_STATUSES,
  type FeeQuery,
  type FeeQuote,
  type HealthCheckResult,
  type Location,
  type MdmConfig,
  type Parcel,
  type ParcelInput,
  type ParcelListPage,
  type ParcelListQuery,
  type ParcelStatus,
  type ShippingErrorDetail,
  type StopDesk,
  type StopDeskQuery,
  type TrackingEvent,
  type TrackResult,
} from '../types';
import {
  compareDates,
  findLocationByName,
  findLocationLoosely,
  isRecord,
  isWilayaCode,
  normalizeAlgerianPhone,
  requireHttps,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

const PROVIDER = 'mdm';
export const MDM_DEFAULT_BASE_URL = 'https://api.mdm.express';
const COUNTRY = 'DZA';
const GEO_PAGE_SIZE = 100;
const GEO_MAX_PAGES = 20;
const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/**
 * MDM parcel status slug → unified status. Slugs from `GET /api/v2/shipping/parcels/metadata`
 * (checked live 2026-10-30), plus `confirmed` seen on orders. MUST stay identical to the PHP
 * `StatusMapper::mdm` (enforced by docs/fixtures/mdm/statuses.json).
 */
const MDM_STATUSES: Record<string, ParcelStatus> = {
  confirmed: 'created',
  'out-of-stock': 'pending',
  preparing: 'created',
  packaged: 'created',
  'ready-for-dispatch': 'created',
  'received-by-mdm': 'in_transit',
  dispatched: 'in_transit',
  received: 'in_transit',
  'in-transit': 'in_transit',
  'ready-for-delivery': 'in_transit',
  'out-for-delivery': 'in_transit',
  postponed: 'in_transit',
  'delivery-attempt-failed': 'in_transit',
  delivered: 'delivered',
  'delivered-partially': 'delivered',
  'delivery-failed': 'returned',
  returning: 'returned',
  'return-ready': 'returned',
  'return-received': 'returned',
  'return-grouped': 'returned',
  returned: 'returned',
  // Exchange / refund parcels (types `exchange`, `refund`).
  'exchange-pending': 'in_transit',
  'exchange-collected': 'delivered',
  'exchange-failed': 'returned',
  'refund-pending': 'in_transit',
  'refund-collected': 'returned',
  refunded: 'returned',
  'refunded-partially': 'returned',
  // Terminal, never delivered nor returned: closest is `cancelled`.
  lost: 'cancelled',
};

const mapMdmKey = createStatusMapper({ exact: MDM_STATUSES });

/** MDM status slug (`out-for-delivery`, `delivered`, ...) → unified status. */
export function mapMdmStatus(native: string | null | undefined): ParcelStatus {
  return mapMdmKey(native);
}

/** `destination.cityId` → `communeId`, ... (validation `payload` paths). */
const FIELDS: Record<string, string> = {
  storeId: 'storeId',
  'destination.cityId': 'communeId',
  'destination.streetAddress': 'address',
  'client.firstName': 'recipientName',
  'client.lastName': 'recipientName',
  'client.phone': 'phone',
  'client.phone2': 'phone2',
  products: 'productList',
  productsPrice: 'price',
  stopDeskId: 'stopDeskId',
  weight: 'weight',
  notes: 'remark',
};

const parseMdmError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : undefined;
  const error = isRecord(body.error) ? body.error : undefined;
  if (!error) return str(body.message) ? { message: str(body.message) } : undefined;
  const code = str(error.code);
  const message = str(error.message) ?? code;
  const details: ShippingErrorDetail[] = [];
  // INVALID_REQUEST: `payload` maps each invalid path to its message
  // (`products.0.trackingId: "... must be a string"`). Elsewhere it holds context values.
  if (code === 'INVALID_REQUEST' && isRecord(error.payload)) {
    for (const [key, value] of Object.entries(error.payload)) {
      if (typeof value === 'string') details.push({ field: fieldOf(key), message: value, code });
    }
  }
  if (details.length === 0 && code) details.push({ message: message ?? code, code });
  return { message, details };
};

/** `products.0.trackingId` → `productList`, `destination.cityId` → `communeId`. */
function fieldOf(path: string): string {
  if (/^products(\.|$)/.test(path)) return 'productList';
  return FIELDS[path] ?? path;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** `DZA16` ↔ `16`. */
function stateIdOf(code: string): string {
  return `${COUNTRY}${String(Number(code)).padStart(2, '0')}`;
}

function codeOfState(row: Record<string, unknown>): string | undefined {
  const raw = str(row.code) ?? str(row.id)?.replace(/^[A-Z]{3}/i, '');
  return raw && /^\d+$/.test(raw) ? String(Number(raw)) : undefined;
}

export class MdmProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly storeId?: string;
  private readonly includeRaw: boolean;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<Location[]>>();

  constructor(config: MdmConfig) {
    const apiKey = config?.apiKey?.trim();
    if (!apiKey)
      throw new ShippingError('AUTH_FAILED', 'MDM requires `apiKey`', {
        provider: PROVIDER,
      });
    this.storeId = config.storeId?.trim() || undefined;
    this.includeRaw = config.includeRaw ?? true;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: requireHttps(config.baseUrl?.trim() || MDM_DEFAULT_BASE_URL, PROVIDER),
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseMdmError,
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * `POST /api/v2/shipping/parcels`. `price` is what the recipient pays: it is sent as
   * `productsPrice` with `isShippingFree: true`, so MDM adds no delivery fee on top.
   * Each product line needs its MDM product id (`productId`, else `sku`) as `trackingId`;
   * an unknown id is HTTP 403 `Products not found` → `VALIDATION_ERROR` on `productList`.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const storeId = this.requireStore('createParcel');
    if (!input.productList?.length || input.productList.some((p) => !(p.productId ?? p.sku)?.trim())) {
      const message =
        'MDM ships products stocked in its catalog: give every productList line its MDM product id (productId or sku, e.g. PRD-…)';
      throw new ShippingError('VALIDATION_ERROR', message, {
        provider: PROVIDER,
        details: [{ field: 'productList', message }],
      });
    }
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const phone2 = input.phone2 ? normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2') : undefined;
    const wilayaCode = await this.resolveWilayaCode(input.wilayaId ?? input.wilayaName!);
    const city = await this.resolveCommune(wilayaCode, input.communeId ?? input.communeName!);

    const [first, ...rest] = input.recipientName.trim().split(/\s+/);
    const client: Record<string, string> = {
      firstName: first!,
      lastName: rest.join(' ') || first!,
      phone,
    };
    if (phone2) client.phone2 = phone2;
    const products = (input.productList ?? []).map((p) => {
      const line: Record<string, unknown> = {
        trackingId: (p.productId ?? p.sku)!.trim(),
        quantity: p.quantity,
      };
      if (p.name?.trim()) line.displayName = p.name.trim();
      if (p.unitPrice !== undefined) line.price = p.unitPrice;
      return line;
    });

    const body: Record<string, unknown> = {
      storeId,
      destination: {
        cityId: city.id,
        streetAddress: input.address.trim() || city.name,
      },
      client,
      products,
      productsPrice: Math.round(input.price),
      isShippingFree: true,
      isStopDesk: Boolean(input.isStopDesk),
    };
    if (input.isStopDesk) body.stopDeskId = String(input.stopDeskId).trim();
    if (input.weight !== undefined) body.weight = input.weight;
    if (input.length !== undefined) body.length = input.length;
    if (input.width !== undefined) body.width = input.width;
    if (input.height !== undefined) body.height = input.height;
    // MDM parcels have no merchant reference field: `orderId` goes in the notes.
    const notes = [input.orderId?.trim() && `Ref: ${input.orderId.trim()}`, input.remark?.trim()]
      .filter(Boolean)
      .join(' — ');
    if (notes) body.notes = notes;

    let res;
    try {
      res = await this.http.request<unknown>({
        method: 'POST',
        path: '/api/v2/shipping/parcels',
        body,
      });
    } catch (err) {
      // Unknown catalog products come back as HTTP 403 AUTH.NOT_AUTHORIZED "Products not found: ...".
      if (err instanceof ShippingError && err.httpStatus === 403 && /products not found/i.test(err.message)) {
        throw new ShippingError('VALIDATION_ERROR', err.message, {
          httpStatus: 403,
          details: [
            {
              field: 'productList',
              message: err.message,
              code: 'AUTH.NOT_AUTHORIZED',
            },
          ],
          raw: err.raw,
          provider: PROVIDER,
        });
      }
      throw err;
    }
    const tracking = isRecord(res.body) ? str(res.body.trackingId) : undefined;
    if (!tracking) {
      throw new ShippingError('PROVIDER_ERROR', 'MDM did not return a tracking id', {
        provider: PROVIDER,
        raw: res.body,
      });
    }
    return withRaw(
      {
        id: tracking,
        trackingNumber: tracking,
        status: 'pending',
        provider: PROVIDER,
      },
      res.body,
      this.includeRaw,
    );
  }

  /** `GET /api/v2/shipping/parcels/{trackingId}`: current `status` and `statusHistory`. */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const { body } = await this.http.request<unknown>({
      method: 'GET',
      path: `/api/v2/shipping/parcels/${encodeURIComponent(tracking)}`,
    });
    if (!isRecord(body)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected MDM parcel response', { provider: PROVIDER, raw: body });
    }
    const events: TrackingEvent[] = (Array.isArray(body.statusHistory) ? body.statusHistory : [])
      .filter(isRecord)
      .map((step, i) => ({
        step,
        i,
        at: toIsoDate(str(step.date) ?? str(step.createdAt) ?? ''),
      }))
      .sort((x, y) => compareDates(x.at, y.at) || x.i - y.i)
      .map(({ step, at }) => {
        const status = str(step.status) ?? '';
        const notes = str(step.notes);
        return withRaw(
          {
            status: mapMdmStatus(status),
            label: notes ? `${status} (${notes})` : status,
            at,
          },
          step,
          this.includeRaw,
        );
      });
    return { parcel: this.toParcel(body, tracking), events };
  }

  /**
   * `POST /api/v2/shipping/parcels/calculate-fees` to one commune (`toCommuneId`, else the
   * wilaya's first deliverable commune). `fees.shipping` → `deliveryFee`, `fees.return` → `returnFee`.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', {
        provider: PROVIDER,
      });
    }
    const wilayaCode = await this.resolveWilayaCode(query.toWilayaId);
    const city = hasValue(query.toCommuneId)
      ? await this.resolveCommune(wilayaCode, query.toCommuneId!)
      : (await this.getCommunes(wilayaCode))[0];
    if (!city)
      throw new ShippingError('NOT_FOUND', `MDM delivers to no commune of wilaya ${wilayaCode}`, {
        provider: PROVIDER,
      });

    const body: Record<string, unknown> = {
      destinationAddress: { cityId: city.id, streetAddress: city.name },
      productsPrice: 0,
      isShippingFree: false,
      isStopDesk: Boolean(query.isStopDesk),
    };
    if (this.storeId) body.storeId = this.storeId;
    if (query.weight !== undefined) body.weight = query.weight;
    if (query.length !== undefined) body.length = query.length;
    if (query.width !== undefined) body.width = query.width;
    if (query.height !== undefined) body.height = query.height;

    const res = await this.http.request<unknown>({
      method: 'POST',
      path: '/api/v2/shipping/parcels/calculate-fees',
      body,
    });
    const fees = isRecord(res.body) && isRecord(res.body.fees) ? res.body.fees : undefined;
    const deliveryFee = num(fees?.shipping);
    if (deliveryFee === undefined) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected MDM fees response', { provider: PROVIDER, raw: res.body });
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    const returnFee = num(fees?.return);
    if (returnFee !== undefined) quote.returnFee = returnFee;
    if (query.isStopDesk) quote.stopDeskFee = deliveryFee;
    return withRaw(quote, res.body, this.includeRaw);
  }

  /** `GET /api/geo/countries/DZA/deliverable-states` (paginated). `Location.id` = official code. */
  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.geoList(`/api/geo/countries/${COUNTRY}/deliverable-states`)
      .then((rows) =>
        rows
          .flatMap((s) => {
            const code = codeOfState(s);
            return code ? [withRaw({ id: code, name: String(s.name ?? '').trim(), code }, s, this.includeRaw)] : [];
          })
          .sort((a, b) => Number(a.id) - Number(b.id)),
      )
      .catch((err) => {
        this.wilayasCache = undefined;
        throw err;
      });
    return this.wilayasCache;
  }

  /** `…/deliverable-states/DZA16/deliverable-cities`. `Location.id` = MDM city id (`DZA161601`). */
  getCommunes(wilayaId: string | number): Promise<Location[]> {
    return this.resolveWilayaCode(wilayaId).then((code) => {
      let cached = this.communesCache.get(code);
      if (!cached) {
        cached = this.geoList(`/api/geo/countries/${COUNTRY}/deliverable-states/${stateIdOf(code)}/deliverable-cities`)
          .then((rows) =>
            rows.flatMap((c) => {
              if (!hasValue(c.id) || !hasValue(c.name)) return [];
              const location: Location = {
                id: String(c.id),
                name: String(c.name).trim(),
                parentId: code,
              };
              if (hasValue(c.code)) location.code = String(c.code);
              return [withRaw(location, c, this.includeRaw)];
            }),
          )
          .catch((err) => {
            this.communesCache.delete(code);
            throw err;
          });
        this.communesCache.set(code, cached);
      }
      return cached;
    });
  }

  /** `GET /api/v2/shipping/companies/offices?countryId=DZA&stateId=…[&cityId]`. Disabled offices are skipped. */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', {
        provider: PROVIDER,
      });
    }
    const code = await this.resolveWilayaCode(query.wilayaId);
    const params: Record<string, string> = {
      countryId: COUNTRY,
      stateId: stateIdOf(code),
    };
    if (hasValue(query.communeId)) params.cityId = (await this.resolveCommune(code, query.communeId!)).id;
    if (this.storeId) params.storeId = this.storeId;

    const { body } = await this.http.request<unknown>({
      method: 'GET',
      path: '/api/v2/shipping/companies/offices',
      query: params,
    });
    const list = isRecord(body) && Array.isArray(body.list) ? body.list : undefined;
    if (!list)
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected MDM offices response', { provider: PROVIDER, raw: body });
    return list
      .filter((o): o is Record<string, unknown> => isRecord(o) && hasValue(o.id) && o.enabled !== false)
      .map((o) => {
        const address = isRecord(o.address) ? o.address : {};
        const desk: StopDesk = {
          id: String(o.id),
          name: String(o.name ?? o.id).trim(),
          wilayaId: code,
        };
        if (hasValue(address.streetAddress)) desk.address = String(address.streetAddress).trim();
        if (hasValue(address.cityId)) desk.communeId = String(address.cityId);
        const phone = Array.isArray(o.phones) ? o.phones.map(str).find(Boolean) : undefined;
        if (phone) desk.phone = phone;
        return withRaw(desk, o, this.includeRaw);
      });
  }

  /**
   * `POST /api/v2/shipping/parcels/search`, newest first. `keyword` → `filters.search`,
   * `updatedSince` → `filters.updatedAt.start`, `status` → `filters.status` (every MDM slug of
   * that unified status), the store → `filters.storeId`; `orderId` (stored in the notes, see
   * `createParcel`) is filtered client-side.
   */
  async listParcels(query: ParcelListQuery = {}): Promise<ParcelListPage> {
    const page = query.page ?? 1;
    const pageSize = Math.min(Math.max(query.pageSize ?? LIST_DEFAULT_PAGE_SIZE, 1), LIST_MAX_PAGE_SIZE);
    if (page < 1) {
      throw new ShippingError('VALIDATION_ERROR', 'page must be >= 1', {
        provider: PROVIDER,
        details: [{ field: 'page', message: 'page must be >= 1' }],
      });
    }
    if (query.status !== undefined && !(PARCEL_STATUSES as readonly string[]).includes(query.status)) {
      throw new ShippingError('VALIDATION_ERROR', 'status must be a unified ParcelStatus', {
        provider: PROVIDER,
        details: [
          {
            field: 'status',
            message: 'status must be a unified ParcelStatus',
          },
        ],
      });
    }

    if (query.allPages) {
      const all: Parcel[] = [];
      let totalCount = 0;
      let lastRaw: unknown;
      let hasNext = true;
      for (let n = 1; hasNext && n <= LIST_MAX_PAGES; n += 1) {
        const result = await this.listPage(query, n, pageSize);
        all.push(...result.parcels);
        if (n === 1) totalCount = result.totalCount;
        lastRaw = result.raw;
        hasNext = result.hasNext;
      }
      // `hasNext` stays true when the page cap cut the walk short.
      return withRaw({ parcels: all, page: 1, pageSize, totalCount, hasNext }, lastRaw, this.includeRaw);
    }

    const result = await this.listPage(query, page, pageSize);
    return withRaw(
      {
        parcels: result.parcels,
        page,
        pageSize,
        totalCount: result.totalCount,
        hasNext: result.hasNext,
      },
      result.raw,
      this.includeRaw,
    );
  }

  async cancelParcel(): Promise<void> {
    throw new ShippingError(
      'NOT_SUPPORTED',
      'MDM has no parcel cancellation endpoint (cancel from the MDM dashboard)',
      {
        provider: PROVIDER,
      },
    );
  }

  /** Probes the deliverable wilayas (bypasses cache). */
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

  private requireStore(method: string): string {
    if (!this.storeId) {
      throw new ShippingError('VALIDATION_ERROR', `MDM ${method} requires \`storeId\` in the client config`, {
        provider: PROVIDER,
        details: [{ field: 'storeId', message: 'storeId is required' }],
      });
    }
    return this.storeId;
  }

  private toParcel(row: Record<string, unknown>, fallbackTracking: string): Parcel {
    const tracking = str(row.trackingId) ?? fallbackTracking;
    return withRaw(
      {
        id: tracking,
        trackingNumber: tracking,
        status: mapMdmStatus(str(row.status)),
        provider: PROVIDER,
      },
      row,
      this.includeRaw,
    );
  }

  private async listPage(
    query: ParcelListQuery,
    page: number,
    pageSize: number,
  ): Promise<{
    parcels: Parcel[];
    totalCount: number;
    hasNext: boolean;
    raw: unknown;
  }> {
    const filters: Record<string, unknown> = {};
    if (this.storeId) filters.storeId = [this.storeId];
    if (query.keyword?.trim()) filters.search = query.keyword.trim();
    if (query.status) filters.status = Object.keys(MDM_STATUSES).filter((slug) => MDM_STATUSES[slug] === query.status);
    if (query.updatedSince) {
      if (Number.isNaN(Date.parse(query.updatedSince))) {
        throw new ShippingError('VALIDATION_ERROR', 'updatedSince must be an ISO 8601 date', {
          provider: PROVIDER,
          details: [
            {
              field: 'updatedSince',
              message: 'updatedSince must be an ISO 8601 date',
            },
          ],
        });
      }
      filters.updatedAt = { start: new Date(query.updatedSince).toISOString() };
    }
    const { body } = await this.http.request<unknown>({
      method: 'POST',
      path: '/api/v2/shipping/parcels/search',
      body: {
        filters,
        sortBy: { createdAt: 'DESC' },
        pagination: { page, perPage: pageSize },
      },
    });
    if (!isRecord(body) || !Array.isArray(body.list)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected MDM parcel list response', {
        provider: PROVIDER,
        raw: body,
      });
    }
    const items = body.list.filter(isRecord);
    const orderId = query.orderId?.trim();
    const parcels = items
      .filter((item) => !orderId || (str(item.notes) ?? '').includes(`Ref: ${orderId}`))
      .map((item) => this.toParcel(item, ''));
    const pagination = isRecord(body.pagination) ? body.pagination : {};
    return {
      parcels,
      totalCount: num(pagination.total) ?? (page - 1) * pageSize + items.length,
      hasNext: typeof pagination.hasMore === 'boolean' ? pagination.hasMore : items.length === pageSize,
      raw: body,
    };
  }

  /** Every page of a geo listing (`pagination.hasMore`), capped at `GEO_MAX_PAGES`. */
  private async geoList(path: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= GEO_MAX_PAGES; page += 1) {
      const params: Record<string, string | number> = {
        page,
        perPage: GEO_PAGE_SIZE,
      };
      if (this.storeId) params.storeId = this.storeId;
      const { body } = await this.http.request<unknown>({
        method: 'GET',
        path,
        query: params,
      });
      if (!isRecord(body) || !Array.isArray(body.list)) {
        throw new ShippingError('PROVIDER_ERROR', 'Unexpected MDM geo response', { provider: PROVIDER, raw: body });
      }
      rows.push(...body.list.filter(isRecord));
      const more = isRecord(body.pagination) ? body.pagination.hasMore === true : false;
      if (!more) break;
    }
    return rows;
  }

  /** Official code `1`–`58` (or `DZA16`) as-is; names through the deliverable wilayas. */
  private async resolveWilayaCode(ref: string | number): Promise<string> {
    const value = String(ref).trim().replace(/^DZA/i, '');
    if (isWilayaCode(value)) return String(Number(value));
    const found = /^\d+$/.test(value) ? undefined : findLocationByName(await this.getWilayas(), value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${String(ref).trim()}`, { provider: PROVIDER });
    return found.id;
  }

  /** By MDM city id, city code, exact name, then spelling-tolerant name (unambiguous only). */
  private async resolveCommune(wilayaCode: string, ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const communes = await this.getCommunes(wilayaCode);
    const found =
      communes.find((c) => c.id === value || c.code === value) ??
      findLocationByName(communes, value) ??
      findLocationLoosely(communes, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilayaCode}`, { provider: PROVIDER });
    }
    return found;
  }
}
