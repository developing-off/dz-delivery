import { ShippingError, isShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper } from '../status';
import {
  PARCEL_STATUSES,
  type FeeQuery,
  type FeeQuote,
  type HealthCheckResult,
  type Location,
  type Parcel,
  type ParcelInput,
  type ParcelListPage,
  type ParcelListQuery,
  type ParcelStatus,
  type ShippingErrorDetail,
  type StockType,
  type StopDesk,
  type StopDeskQuery,
  type TrackingEvent,
  type TrackResult,
  type ZRExpressConfig,
} from '../types';
import {
  findLocationByName,
  isRecord,
  isUuid,
  isWilayaCode,
  normalizeAlgerianPhone,
  productDescription,
  randomUuid,
  sortEventsAscending,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

export const ZREXPRESS_DEFAULT_BASE_URL = 'https://api.zrexpress.app';
const PROVIDER = 'zrexpress';
const API = '/api/v1';
const PAGE_SIZE = 1000;
const MAX_AMOUNT = 150_000;
const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 1000;
/** Safety cap when `allPages: true` (pages × pageSize). */
const LIST_MAX_PAGES = 100;
const BULK_CREATE_MAX = 100;
const BULK_DELETE_MAX = 200;
const LABELS_MULTIPLE_MAX = 250;
const LABELS_INDIVIDUAL_MAX = 100;

/** ZRExpress-only: HTML label download (SAS URL). */
export interface LabelResult {
  fileUrl?: string;
  labels?: Array<{ trackingNumber: string; fileUrl: string }>;
  failedTrackingNumbers: string[];
  raw?: unknown;
}

export interface BulkCreateFailure {
  index: number;
  orderId?: string;
  error: { code: string; message: string; errorCode?: string };
}

export interface BulkCreateResult {
  successes: Parcel[];
  failures: BulkCreateFailure[];
  raw?: unknown;
}

export interface BulkDeleteSuccess {
  index: number;
  parcelId?: string;
  trackingNumber?: string;
}

export interface BulkDeleteFailure {
  index: number;
  error: { code: string; message: string; errorCode?: string };
}

export interface BulkDeleteResult {
  successes: BulkDeleteSuccess[];
  failures: BulkDeleteFailure[];
  raw?: unknown;
}

/**
 * Native state → unified status. Matching is case-, accent- and separator-insensitive
 * (`commande_recue` = `CommandeRecue`). Order: exact table, then "returned" prefixes,
 * then "in transit" keywords. MUST stay identical to the PHP `StatusMapper::zrexpress`
 * (enforced by docs/fixtures/zrexpress/statuses.json).
 */
export const mapZRExpressStatus = createStatusMapper({
  exact: {
    commande_recue: 'pending',
    OrderReceived: 'pending',
    pret_a_expedier: 'created',
    ReadyToDispatch: 'created',
    confirme_au_bureau: 'in_transit',
    Delivered: 'delivered',
    livre: 'delivered',
    livree: 'delivered',
    encaisse: 'delivered',
    Cancelled: 'cancelled',
    Canceled: 'cancelled',
    annule: 'cancelled',
    annulee: 'cancelled',
    deleted: 'cancelled',
    supprime: 'cancelled',
    supprimee: 'cancelled',
  },
  prefixes: [
    ['returned', 'returned'],
    ['return', 'returned'],
    ['retour', 'returned'],
    ['retourne', 'returned'],
  ],
  keywords: [
    'outfordelivery', 'enlivraison', 'sortieenlivraison', 'transit', 'hub', 'transfer',
    'dispatched', 'expedie', 'pickedup', 'ramasse', 'shipped', 'center', 'centre',
    'attempt', 'tentative', 'echec', 'failed', 'postponed', 'reporte', 'enattente',
    'awaiting', 'pickup', 'station', 'wilaya',
  ].map((k) => [k, 'in_transit'] as [string, ParcelStatus]),
});

/** RFC 7807 problem details → message / details. */
const parseZRExpressError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body } : undefined;
  const message = str(body.detail) || str(body.title);
  const details: ShippingErrorDetail[] = [];
  const errors = body.errors;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (isRecord(e)) {
        details.push({ message: str(e.description) ?? str(e.message) ?? JSON.stringify(e), code: str(e.code) });
      }
    }
  } else if (isRecord(errors)) {
    // ASP.NET-style `{ "Field": ["msg", ...] }`
    for (const [field, msgs] of Object.entries(errors)) {
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) details.push({ field, message: String(m) });
    }
  }
  return { message, details };
};

interface ZRTerritory {
  id: string;
  code?: number | string | null;
  name: string;
  postalCode?: string | null;
  PostalCode?: string | null;
  level?: string;
  parentId?: string | null;
  delivery?: { hasHomeDelivery?: boolean; hasPickupPoint?: boolean } | null;
}

interface ZRTerritoryPage {
  items?: ZRTerritory[];
  hasNext?: boolean;
}

interface ZRState {
  name?: string;
  description?: string;
}

interface ZRParcel {
  id: string;
  trackingNumber?: string;
  state?: ZRState | null;
}

interface ZRStateHistoryItem {
  createdAt: string;
  newState?: ZRState | null;
}

interface ZRRate {
  deliveryPrices?: Array<{ deliveryType?: string | null; price?: number }> | null;
}

interface ZRHubCoordinates {
  lat?: number | null;
  lng?: number | null;
}

interface ZRHubPhone {
  number1?: string | null;
  number2?: string | null;
  number3?: string | null;
}

interface ZRHubAddress {
  street?: string | null;
  city?: string | null;
  cityTerritoryId?: string | null;
  district?: string | null;
  districtTerritoryId?: string | null;
  postalCode?: string | null;
  coordinates?: ZRHubCoordinates | null;
}

interface ZRHub {
  id: string;
  name?: string | null;
  type?: string | null;
  isPickupPoint?: boolean | null;
  IsPickupPoint?: boolean | null;
  address?: ZRHubAddress | null;
  openingHours?: string | null;
  phone?: ZRHubPhone | null;
}

interface ZRHubPage {
  items?: ZRHub[];
  hasNext?: boolean;
}

export class ZRExpressProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly includeRaw: boolean;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<Location[]>>();

  constructor(config: ZRExpressConfig) {
    if (!config?.apiKey || !config?.tenant) {
      throw new ShippingError('AUTH_FAILED', 'ZRExpress requires `apiKey` and `tenant`', { provider: PROVIDER });
    }
    this.includeRaw = config.includeRaw ?? true;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? ZREXPRESS_DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseZRExpressError,
      headers: {
        'X-Api-Key': config.apiKey,
        'X-Tenant': config.tenant,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  async createParcel(input: ParcelInput): Promise<Parcel> {
    const body = await this.buildCreateBody(input, { requireOrderId: false });
    const created = await this.http.request<{ id?: string }>({ method: 'POST', path: `${API}/parcels`, body });
    const id = isRecord(created.body) ? str(created.body.id) : undefined;
    if (!id) {
      throw new ShippingError('PROVIDER_ERROR', 'ZRExpress did not return a parcel id', {
        provider: PROVIDER,
        httpStatus: created.status,
        raw: created.body,
      });
    }

    const parcel = await this.getParcel(id);
    return this.toParcel(parcel);
  }

  /**
   * ZRExpress extra — `POST /parcels/bulk` (max 100). Each item **must** have `orderId`
   * (`externalId`). Partial success (`207`) and all-failed (`400` with report body) return
   * a structured result instead of throwing.
   */
  async createParcelsBulk(inputs: ParcelInput[]): Promise<BulkCreateResult> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ShippingError('VALIDATION_ERROR', 'createParcelsBulk requires at least one parcel', {
        provider: PROVIDER,
        details: [{ field: 'inputs', message: 'at least one parcel is required' }],
      });
    }
    if (inputs.length > BULK_CREATE_MAX) {
      throw new ShippingError('VALIDATION_ERROR', `createParcelsBulk accepts at most ${BULK_CREATE_MAX} parcels`, {
        provider: PROVIDER,
        details: [{ field: 'inputs', message: `max ${BULK_CREATE_MAX}` }],
      });
    }

    const parcels: Record<string, unknown>[] = [];
    for (let i = 0; i < inputs.length; i++) {
      try {
        parcels.push(await this.buildCreateBody(inputs[i]!, { requireOrderId: true, index: i }));
      } catch (err) {
        if (isShippingError(err) && err.code === 'VALIDATION_ERROR') throw err;
        throw err;
      }
    }

    const body = await this.requestBulkReport('POST', `${API}/parcels/bulk`, { parcels });
    return this.mapBulkCreateResult(body);
  }

  /**
   * ZRExpress extra — delete by UUID (`DELETE /parcels/bulk`) and/or tracking
   * (`DELETE /parcels/bulk/by-tracking-number`). Max 200 refs. Mixed lists are split
   * and indices remapped to the original order.
   */
  async deleteParcelsBulk(refs: string[]): Promise<BulkDeleteResult> {
    const cleaned = (refs ?? []).map((r) => r?.trim()).filter(Boolean) as string[];
    if (cleaned.length === 0) {
      throw new ShippingError('VALIDATION_ERROR', 'deleteParcelsBulk requires at least one id or tracking number', {
        provider: PROVIDER,
        details: [{ field: 'refs', message: 'at least one reference is required' }],
      });
    }
    if (cleaned.length > BULK_DELETE_MAX) {
      throw new ShippingError('VALIDATION_ERROR', `deleteParcelsBulk accepts at most ${BULK_DELETE_MAX} references`, {
        provider: PROVIDER,
        details: [{ field: 'refs', message: `max ${BULK_DELETE_MAX}` }],
      });
    }

    const uuidEntries: Array<{ index: number; value: string }> = [];
    const trackingEntries: Array<{ index: number; value: string }> = [];
    cleaned.forEach((value, index) => {
      if (isUuid(value)) uuidEntries.push({ index, value });
      else trackingEntries.push({ index, value });
    });

    const successes: BulkDeleteSuccess[] = [];
    const failures: BulkDeleteFailure[] = [];
    const rawParts: unknown[] = [];

    if (uuidEntries.length > 0) {
      const body = await this.requestBulkReport('DELETE', `${API}/parcels/bulk`, {
        parcelIds: uuidEntries.map((e) => e.value),
      });
      rawParts.push(body);
      this.mergeBulkDelete(body, uuidEntries, successes, failures);
    }
    if (trackingEntries.length > 0) {
      const body = await this.requestBulkReport('DELETE', `${API}/parcels/bulk/by-tracking-number`, {
        trackingNumbers: trackingEntries.map((e) => e.value),
      });
      rawParts.push(body);
      this.mergeBulkDelete(body, trackingEntries, successes, failures);
    }

    successes.sort((a, b) => a.index - b.index);
    failures.sort((a, b) => a.index - b.index);
    const result: BulkDeleteResult = { successes, failures };
    if (this.includeRaw) result.raw = rawParts.length === 1 ? rawParts[0] : rawParts;
    return result;
  }

  /**
   * ZRExpress extra — HTML labels (SAS URL).
   * `mode: 'multiple'` (default) → one file for up to 250 trackings.
   * `mode: 'individual'` → one file per tracking (max 100).
   */
  async generateLabels(
    trackingNumbers: string[],
    options?: { mode?: 'multiple' | 'individual' },
  ): Promise<LabelResult> {
    const list = (trackingNumbers ?? []).map((t) => t?.trim()).filter(Boolean) as string[];
    if (list.length === 0) {
      throw new ShippingError('VALIDATION_ERROR', 'generateLabels requires at least one tracking number', {
        provider: PROVIDER,
        details: [{ field: 'trackingNumbers', message: 'at least one tracking number is required' }],
      });
    }
    const mode = options?.mode ?? 'multiple';
    const max = mode === 'individual' ? LABELS_INDIVIDUAL_MAX : LABELS_MULTIPLE_MAX;
    if (list.length > max) {
      throw new ShippingError('VALIDATION_ERROR', `generateLabels(${mode}) accepts at most ${max} tracking numbers`, {
        provider: PROVIDER,
        details: [{ field: 'trackingNumbers', message: `max ${max}` }],
      });
    }

    const path =
      mode === 'individual' ? `${API}/parcels/labels/individual` : `${API}/parcels/labels/multiple`;
    const res = await this.http.request<Record<string, unknown>>({
      method: 'POST',
      path,
      body: { trackingNumbers: list },
    });
    const body = isRecord(res.body) ? res.body : {};
    const failed = Array.isArray(body.failedTrackingNumbers)
      ? body.failedTrackingNumbers.map((t) => String(t))
      : [];

    if (mode === 'individual') {
      const files = Array.isArray(body.parcelLabelFiles) ? body.parcelLabelFiles : [];
      const labels = files
        .filter(isRecord)
        .map((f) => ({
          trackingNumber: str(f.trackingNumber) ?? '',
          fileUrl: str(f.fileUrl) ?? '',
        }))
        .filter((l) => l.trackingNumber && l.fileUrl);
      return withRaw({ labels, failedTrackingNumbers: failed }, res.body, this.includeRaw);
    }

    const fileUrl = str(body.fileUrl);
    const out: LabelResult = { failedTrackingNumbers: failed };
    if (fileUrl) out.fileUrl = fileUrl;
    return withRaw(out, res.body, this.includeRaw);
  }

  async track(trackingNumber: string): Promise<TrackResult> {
    if (!trackingNumber?.trim()) {
      throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });
    }
    const parcel = await this.getParcel(trackingNumber.trim());
    const history = await this.http.request<ZRStateHistoryItem[] | { items?: ZRStateHistoryItem[] }>({
      method: 'GET',
      path: `${API}/parcels/${encodeURIComponent(parcel.id)}/state-history`,
    });
    const items = Array.isArray(history.body) ? history.body : (history.body?.items ?? []);
    const events: TrackingEvent[] = items.map((item) =>
      withRaw(
        {
          status: mapZRExpressStatus(item.newState?.name),
          label: item.newState?.description || item.newState?.name || '',
          at: toIsoDate(item.createdAt, '+00:00'),
        },
        item,
        this.includeRaw,
      ),
    );
    return { parcel: this.toParcel(parcel), events: sortEventsAscending(events) };
  }

  /**
   * `POST /api/v1/parcels/search` — paginated account parcels with current status.
   * Does not include state-history events (use `track` for that).
   * @see https://docs.zrexpress.app/reference/searchsupplierparcelsendpoint
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
        details: [{ field: 'status', message: 'status must be a unified ParcelStatus' }],
      });
    }

    if (query.allPages) {
      const all: Parcel[] = [];
      let totalCount = 0;
      let lastRaw: unknown;
      let pageNumber = 1;
      let hasNext = true;
      while (hasNext && pageNumber <= LIST_MAX_PAGES) {
        const pageResult = await this.searchParcelsPage({ ...query, page: pageNumber, pageSize, allPages: false });
        all.push(...pageResult.parcels);
        totalCount = pageResult.totalCount;
        lastRaw = pageResult.raw;
        hasNext = pageResult.hasNext;
        pageNumber += 1;
      }
      const parcels = query.status ? all.filter((p) => p.status === query.status) : all;
      return withRaw(
        { parcels, page: 1, pageSize, totalCount, hasNext: false },
        lastRaw,
        this.includeRaw,
      );
    }

    const pageResult = await this.searchParcelsPage({ ...query, page, pageSize });
    const parcels = query.status
      ? pageResult.parcels.filter((p) => p.status === query.status)
      : pageResult.parcels;
    return withRaw(
      {
        parcels,
        page: pageResult.page,
        pageSize: pageResult.pageSize,
        totalCount: pageResult.totalCount,
        hasNext: pageResult.hasNext,
      },
      pageResult.raw,
      this.includeRaw,
    );
  }

  /**
   * Uses the effective rate of the destination wilaya. `toCommuneId`, `fromWilayaId`
   * and `weight` are ignored: the rates endpoint prices per destination territory only.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (query?.toWilayaId === undefined || query.toWilayaId === '') {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }
    const wilaya = await this.resolveWilaya(query.toWilayaId);
    const res = await this.http.request<ZRRate>({
      method: 'GET',
      path: `${API}/delivery-pricing/rates/${encodeURIComponent(wilaya.id)}`,
    });
    const prices = res.body?.deliveryPrices ?? [];
    const priceFor = (type: string) =>
      prices.find((p) => (p.deliveryType ?? '').toLowerCase() === type && typeof p.price === 'number')?.price;

    const home = priceFor('home');
    const pickup = priceFor('pickup-point');
    const deliveryFee = query.isStopDesk ? pickup : home;
    if (deliveryFee === undefined) {
      throw new ShippingError(
        'NOT_FOUND',
        `No ${query.isStopDesk ? 'pickup-point' : 'home'} rate for wilaya ${wilaya.name}`,
        { provider: PROVIDER, raw: res.body },
      );
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    if (pickup !== undefined) quote.stopDeskFee = pickup;
    return withRaw(quote, res.body, this.includeRaw);
  }

  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.searchTerritories('wilaya').catch((err) => {
      this.wilayasCache = undefined;
      throw err;
    });
    return this.wilayasCache;
  }

  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    const wilaya = await this.resolveWilaya(wilayaId);
    let cached = this.communesCache.get(wilaya.id);
    if (!cached) {
      cached = this.searchTerritories('commune', wilaya.id).catch((err) => {
        this.communesCache.delete(wilaya.id);
        throw err;
      });
      this.communesCache.set(wilaya.id, cached);
    }
    return cached;
  }

  /**
   * `POST /api/v1/hubs/search` filtered to pickup points of the wilaya
   * (optional commune). Hub `id` is the `stopDeskId` / `hubId` for createParcel.
   *
   * Prefer **wilaya-only** first: many ZR hubs are not tagged with
   * `districtTerritoryId`, so `communeId` often returns `[]` even when the wilaya
   * has desks. When that happens, this method throws `NOT_FOUND` with a hint to
   * retry without `communeId`.
   *
   * @see https://docs.zrexpress.app/reference/searchhubsendpoint
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (query?.wilayaId === undefined || query.wilayaId === '') {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    const wilaya = await this.resolveWilaya(query.wilayaId);
    const communeTerritoryId =
      query.communeId !== undefined && query.communeId !== ''
        ? await this.resolveCommuneRef(wilaya.id, query.communeId)
        : undefined;

    const hubs = await this.searchHubs(wilaya.id, communeTerritoryId);
    if (hubs.length === 0 && communeTerritoryId) {
      const wilayaHubs = await this.searchHubs(wilaya.id);
      if (wilayaHubs.length > 0) {
        const message =
          `No ZRExpress stop desks for this commune; ${wilayaHubs.length} hub(s) exist in the wilaya — ` +
          'call getStopDesks({ wilayaId }) without communeId';
        throw new ShippingError('NOT_FOUND', message, {
          provider: PROVIDER,
          details: [
            {
              field: 'communeId',
              message,
              code: 'EMPTY_COMMUNE_HUBS',
            },
          ],
        });
      }
    }
    return hubs.map((hub) => this.toStopDesk(hub, wilaya.id));
  }

  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const ref = trackingNumberOrId?.trim();
    if (!ref) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });
    const id = isUuid(ref) ? ref : (await this.getParcel(ref)).id;
    await this.http.request({ method: 'DELETE', path: `${API}/parcels/${encodeURIComponent(id)}` });
  }

  /** Probes territories search for wilayas (bypasses cache). */
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

  private async buildCreateBody(
    input: ParcelInput,
    opts: { requireOrderId: boolean; index?: number },
  ): Promise<Record<string, unknown>> {
    const field = (name: string) => (opts.index !== undefined ? `inputs[${opts.index}].${name}` : name);
    validateParcelInput(input, PROVIDER);
    if (input.price > MAX_AMOUNT) {
      throw new ShippingError('VALIDATION_ERROR', `price must be <= ${MAX_AMOUNT} DZD for ZRExpress`, {
        provider: PROVIDER,
        details: [{ field: field('price'), message: `price must be <= ${MAX_AMOUNT} DZD for ZRExpress` }],
      });
    }
    if (opts.requireOrderId && !input.orderId?.trim()) {
      throw new ShippingError('VALIDATION_ERROR', 'orderId is required for bulk create (ZRExpress externalId)', {
        provider: PROVIDER,
        details: [{ field: field('orderId'), message: 'orderId is required for bulk create' }],
      });
    }
    if (input.orderId !== undefined && input.orderId.length > 100) {
      throw new ShippingError('VALIDATION_ERROR', 'orderId must be at most 100 characters', {
        provider: PROVIDER,
        details: [{ field: field('orderId'), message: 'orderId must be at most 100 characters' }],
      });
    }

    const phone: Record<string, string> = {
      number1: normalizeAlgerianPhone(input.phone, 'international', PROVIDER, field('phone')),
    };
    if (input.phone2) {
      phone.number2 = normalizeAlgerianPhone(input.phone2, 'international', PROVIDER, field('phone2'));
    }

    const wilaya = await this.resolveWilaya(input.wilayaId ?? input.wilayaName!);
    const communeId = await this.resolveCommuneId(wilaya.id, input);
    const orderedProducts = this.buildOrderedProducts(input);

    const first = orderedProducts[0] as Record<string, unknown>;
    if (input.length !== undefined) first.length = input.length;
    if (input.width !== undefined) first.width = input.width;
    if (input.height !== undefined) first.height = input.height;

    const description = this.parcelDescription(input);
    if (description.trim().length < 2) {
      throw new ShippingError('VALIDATION_ERROR', 'Product description must be at least 2 characters', {
        provider: PROVIDER,
        details: [{ field: field('productName'), message: 'Product description must be at least 2 characters' }],
      });
    }

    const body: Record<string, unknown> = {
      customer: { customerId: randomUuid(), name: input.recipientName.trim(), phone },
      deliveryAddress: { street: input.address.trim(), cityTerritoryId: wilaya.id, districtTerritoryId: communeId },
      orderedProducts,
      deliveryType: input.isStopDesk ? 'pickup-point' : 'home',
      amount: input.price,
      description,
    };
    if (input.isStopDesk) body.hubId = input.stopDeskId;
    if (input.weight !== undefined) body.weight = { weight: input.weight };
    if (input.orderId) body.externalId = input.orderId;
    return body;
  }

  /** POST/DELETE bulk endpoints: accept 200/207 and 400 when the body is a bulk report. */
  private async requestBulkReport(
    method: 'POST' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      const res = await this.http.request<Record<string, unknown>>({ method, path, body });
      return isRecord(res.body) ? res.body : {};
    } catch (err) {
      if (isShippingError(err) && err.httpStatus === 400 && isBulkReport(err.raw)) {
        return err.raw as Record<string, unknown>;
      }
      throw err;
    }
  }

  private mapBulkCreateResult(body: Record<string, unknown>): BulkCreateResult {
    const successes: Parcel[] = [];
    for (const item of Array.isArray(body.successes) ? body.successes : []) {
      if (!isRecord(item)) continue;
      const id = str(item.parcelId);
      if (!id) continue;
      successes.push(
        withRaw(
          {
            id,
            trackingNumber: str(item.trackingNumber) ?? id,
            status: 'pending' as ParcelStatus,
            provider: PROVIDER,
          },
          item,
          this.includeRaw,
        ),
      );
    }
    const failures: BulkCreateFailure[] = [];
    for (const item of Array.isArray(body.failures) ? body.failures : []) {
      if (!isRecord(item)) continue;
      const index = Number(item.index);
      const failure: BulkCreateFailure = {
        index: Number.isFinite(index) ? index : -1,
        error: {
          code: 'PROVIDER_ERROR',
          message: str(item.errorMessage) ?? str(item.errorCode) ?? 'Bulk create failed',
          ...(str(item.errorCode) ? { errorCode: str(item.errorCode)! } : {}),
        },
      };
      const orderId = str(item.externalId);
      if (orderId) failure.orderId = orderId;
      failures.push(failure);
    }
    const result: BulkCreateResult = { successes, failures };
    if (this.includeRaw) result.raw = body;
    return result;
  }

  private mergeBulkDelete(
    body: Record<string, unknown>,
    indexMap: Array<{ index: number; value: string }>,
    successes: BulkDeleteSuccess[],
    failures: BulkDeleteFailure[],
  ): void {
    for (const item of Array.isArray(body.successes) ? body.successes : []) {
      if (!isRecord(item)) continue;
      const localIndex = Number(item.index);
      const mapped = Number.isFinite(localIndex) ? indexMap[localIndex] : undefined;
      const entry: BulkDeleteSuccess = { index: mapped?.index ?? localIndex };
      const parcelId = str(item.parcelId);
      if (parcelId) entry.parcelId = parcelId;
      const trackingNumber = str(item.trackingNumber);
      if (trackingNumber) entry.trackingNumber = trackingNumber;
      successes.push(entry);
    }
    for (const item of Array.isArray(body.failures) ? body.failures : []) {
      if (!isRecord(item)) continue;
      const localIndex = Number(item.index);
      const mapped = Number.isFinite(localIndex) ? indexMap[localIndex] : undefined;
      failures.push({
        index: mapped?.index ?? localIndex,
        error: {
          code: 'PROVIDER_ERROR',
          message: str(item.errorMessage) ?? str(item.errorCode) ?? 'Bulk delete failed',
          ...(str(item.errorCode) ? { errorCode: str(item.errorCode)! } : {}),
        },
      });
    }
  }

  /**
   * Builds `orderedProducts[]`. Default `stockType` is `"none"` (no catalog).
   * `local` / `warehouse` require `productId` + `sku` per ZRExpress docs.
   */
  private buildOrderedProducts(input: ParcelInput): Array<Record<string, unknown>> {
    const defaultStock = this.resolveStockType(input.stockType, 'stockType');
    const items = input.productList
      ? input.productList.map((p, i) => {
          const stockType = this.resolveStockType(p.stockType ?? defaultStock, `productList.${i}.stockType`);
          this.assertCatalogFields(stockType, p.productId, p.sku, `productList.${i}`);
          return {
            productName: p.name,
            quantity: p.quantity,
            // Assumption: ZRExpress requires a unit price; 0 when the merchant did not provide one.
            unitPrice: p.unitPrice ?? 0,
            stockType,
            ...(p.sku ? { productSku: p.sku } : {}),
            ...(p.productId ? { productId: p.productId } : {}),
          };
        })
      : (() => {
          const stockType = defaultStock;
          this.assertCatalogFields(stockType, undefined, undefined, 'productName');
          return [
            {
              productName: input.productName!.trim(),
              quantity: 1,
              unitPrice: input.price,
              stockType,
            },
          ];
        })();
    return items;
  }

  private resolveStockType(value: StockType | undefined, field: string): StockType {
    const stockType = value ?? 'none';
    if (stockType !== 'none' && stockType !== 'local' && stockType !== 'warehouse') {
      throw new ShippingError('VALIDATION_ERROR', 'stockType must be one of: none, local, warehouse', {
        provider: PROVIDER,
        details: [{ field, message: 'stockType must be one of: none, local, warehouse' }],
      });
    }
    return stockType;
  }

  private assertCatalogFields(
    stockType: StockType,
    productId: string | undefined,
    sku: string | undefined,
    fieldPrefix: string,
  ): void {
    if (stockType === 'none') return;
    const details: ShippingErrorDetail[] = [];
    if (!productId?.trim()) {
      details.push({
        field: `${fieldPrefix}.productId`,
        message: `productId is required when stockType is "${stockType}"`,
      });
    }
    if (!sku?.trim()) {
      details.push({
        field: `${fieldPrefix}.sku`,
        message: `sku is required when stockType is "${stockType}"`,
      });
    }
    if (details.length > 0) {
      throw new ShippingError(
        'VALIDATION_ERROR',
        `productId and sku are required when stockType is "${stockType}"`,
        { provider: PROVIDER, details },
      );
    }
  }

  /** Product text (+ optional remark), capped at 250 chars for the API. */
  private parcelDescription(input: ParcelInput): string {
    const base = productDescription(input);
    const remark = input.remark?.trim();
    const full = remark ? `${base} - ${remark}` : base;
    return full.slice(0, 250);
  }

  private async searchParcelsPage(query: ParcelListQuery & { page: number; pageSize: number }): Promise<{
    parcels: Parcel[];
    page: number;
    pageSize: number;
    totalCount: number;
    hasNext: boolean;
    raw: unknown;
  }> {
    const filters: Array<Record<string, unknown>> = [];
    if (query.orderId?.trim()) {
      filters.push({ field: 'externalId', operator: 'eq', value: query.orderId.trim() });
    }
    if (query.updatedSince?.trim()) {
      filters.push({ field: 'lastStateUpdateAt', operator: 'gte', value: query.updatedSince.trim() });
    }

    const body: Record<string, unknown> = {
      pageNumber: query.page,
      pageSize: query.pageSize,
      orderBy: ['createdAt desc'],
    };
    if (query.keyword?.trim()) body.keyword = query.keyword.trim();
    if (filters.length > 0) body.advancedFilter = { logic: 'and', filters };

    const res = await this.http.request<{
      items?: ZRParcel[];
      pageNumber?: number;
      pageSize?: number;
      totalCount?: number;
      hasNext?: boolean;
    }>({ method: 'POST', path: `${API}/parcels/search`, body });

    if (!isRecord(res.body) || !Array.isArray(res.body.items)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected ZRExpress parcels search response', {
        provider: PROVIDER,
        raw: res.body,
      });
    }

    const parcels = res.body.items
      .filter((item) => isRecord(item) && str(item.id))
      .map((item) => this.toParcel(item as ZRParcel));

    return {
      parcels,
      page: Number(res.body.pageNumber) || query.page,
      pageSize: Number(res.body.pageSize) || query.pageSize,
      totalCount: Number(res.body.totalCount) || parcels.length,
      hasNext: Boolean(res.body.hasNext),
      raw: res.body,
    };
  }

  /** `GET /parcels/{x}` accepts both the parcel UUID and the tracking number. */
  private async getParcel(idOrTracking: string): Promise<ZRParcel> {
    const res = await this.http.request<ZRParcel>({
      method: 'GET',
      path: `${API}/parcels/${encodeURIComponent(idOrTracking)}`,
    });
    if (!isRecord(res.body) || !str(res.body.id)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected ZRExpress parcel response', {
        provider: PROVIDER,
        raw: res.body,
      });
    }
    return res.body;
  }

  private toParcel(native: ZRParcel): Parcel {
    return withRaw(
      {
        id: String(native.id),
        trackingNumber: str(native.trackingNumber) ?? String(native.id),
        status: mapZRExpressStatus(native.state?.name),
        provider: PROVIDER,
      },
      native,
      this.includeRaw,
    );
  }

  /**
   * Assumption: `advancedFilter` uses `{ field, operator: "eq", value }` with `logic: "and"`
   * (operator names are not documented). Results are also filtered client-side so the
   * method stays correct if the server ignores the filter.
   */
  private async searchTerritories(level: 'wilaya' | 'commune', parentId?: string): Promise<Location[]> {
    const filters: Array<Record<string, unknown>> = [{ field: 'level', operator: 'eq', value: level }];
    if (parentId) filters.push({ field: 'parentId', operator: 'eq', value: parentId });

    const all: ZRTerritory[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const res = await this.http.request<ZRTerritoryPage>({
        method: 'POST',
        path: `${API}/territories/search`,
        body: {
          pageNumber,
          pageSize: PAGE_SIZE,
          orderBy: ['code asc'],
          advancedFilter: { logic: 'and', filters },
        },
      });
      const items = res.body?.items;
      if (!Array.isArray(items)) {
        throw new ShippingError('PROVIDER_ERROR', 'Unexpected ZRExpress territories response', {
          provider: PROVIDER,
          raw: res.body,
        });
      }
      all.push(...items);
      if (!res.body.hasNext || items.length === 0) break;
    }

    return all
      .filter((t) => !t.level || t.level.toLowerCase() === level)
      .filter((t) => !parentId || t.parentId === parentId)
      .filter((t) => !t.delivery || t.delivery.hasHomeDelivery !== false || t.delivery.hasPickupPoint !== false)
      .map((t) => this.toLocation(t, level));
  }

  private toLocation(t: ZRTerritory, level: 'wilaya' | 'commune'): Location {
    const loc: Location = { id: String(t.id), name: t.name };
    if (t.parentId) loc.parentId = String(t.parentId);
    const code = str(t.code) ?? (level === 'commune' ? (str(t.postalCode) ?? str(t.PostalCode)) : undefined);
    if (code) loc.code = code;
    return withRaw(loc, t, this.includeRaw);
  }

  /**
   * Assumption: same `advancedFilter` shape as territories (`operator: "eq"`).
   * Results are also filtered client-side so the method stays correct if the
   * server ignores nested address filters.
   */
  private async searchHubs(wilayaTerritoryId: string, communeTerritoryId?: string): Promise<ZRHub[]> {
    const filters: Array<Record<string, unknown>> = [
      { field: 'isPickupPoint', operator: 'eq', value: true },
      { field: 'address.cityTerritoryId', operator: 'eq', value: wilayaTerritoryId },
    ];
    if (communeTerritoryId) {
      filters.push({ field: 'address.districtTerritoryId', operator: 'eq', value: communeTerritoryId });
    }

    const all: ZRHub[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const res = await this.http.request<ZRHubPage>({
        method: 'POST',
        path: `${API}/hubs/search`,
        body: {
          pageNumber,
          pageSize: PAGE_SIZE,
          orderBy: ['name asc'],
          advancedFilter: { logic: 'and', filters },
        },
      });
      const items = res.body?.items;
      if (!Array.isArray(items)) {
        throw new ShippingError('PROVIDER_ERROR', 'Unexpected ZRExpress hubs response', {
          provider: PROVIDER,
          raw: res.body,
        });
      }
      all.push(...items);
      if (!res.body.hasNext || items.length === 0) break;
    }

    return all.filter((hub) => {
      if (!str(hub.id)) return false;
      const pickup = hub.isPickupPoint ?? hub.IsPickupPoint;
      if (pickup === false) return false;
      const cityId = str(hub.address?.cityTerritoryId);
      if (cityId && cityId !== wilayaTerritoryId) return false;
      const districtId = str(hub.address?.districtTerritoryId);
      if (communeTerritoryId && districtId && districtId !== communeTerritoryId) return false;
      return true;
    });
  }

  private toStopDesk(hub: ZRHub, wilayaId: string): StopDesk {
    const address = str(hub.address?.street);
    const desk: StopDesk = {
      id: String(hub.id),
      name: str(hub.name) ?? '',
      wilayaId: str(hub.address?.cityTerritoryId) ?? wilayaId,
    };
    if (address) desk.address = address;
    const communeId = str(hub.address?.districtTerritoryId);
    if (communeId) desk.communeId = communeId;
    const phone = str(hub.phone?.number1);
    if (phone) desk.phone = phone;
    const openingHours = str(hub.openingHours);
    if (openingHours) desk.openingHours = openingHours;
    const lat = hub.address?.coordinates?.lat;
    const lng = hub.address?.coordinates?.lng;
    if (typeof lat === 'number' && Number.isFinite(lat)) desk.lat = lat;
    if (typeof lng === 'number' && Number.isFinite(lng)) desk.lng = lng;
    const type = str(hub.type);
    if (type) desk.type = type;
    return withRaw(desk, hub, this.includeRaw);
  }

  /** Accepts a territory UUID, an official code `1`–`58`, or a wilaya name. */
  private async resolveWilaya(ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    if (isUuid(value)) {
      const known = this.wilayasCache ? (await this.getWilayas()).find((w) => w.id === value) : undefined;
      return known ?? { id: value, name: value };
    }
    const wilayas = await this.getWilayas();
    const found = isWilayaCode(ref)
      ? wilayas.find((w) => Number(w.code) === Number(value))
      : findLocationByName(wilayas, value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown ZRExpress wilaya "${value}"`, { provider: PROVIDER });
    return found;
  }

  private async resolveCommuneId(wilayaId: string, input: ParcelInput): Promise<string> {
    if (input.communeId !== undefined && input.communeId !== '') {
      return this.resolveCommuneRef(wilayaId, input.communeId);
    }
    const communes = await this.getCommunes(wilayaId);
    const found = findLocationByName(communes, input.communeName!);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown ZRExpress commune "${input.communeName}"`, { provider: PROVIDER });
    }
    return found.id;
  }

  /** Accepts a commune UUID, code/postal code, or name within the wilaya. */
  private async resolveCommuneRef(wilayaId: string, ref: string | number): Promise<string> {
    const value = String(ref).trim();
    if (isUuid(value)) return value;
    const communes = await this.getCommunes(wilayaId);
    const found = communes.find((c) => c.code === value) ?? findLocationByName(communes, value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown ZRExpress commune "${value}"`, { provider: PROVIDER });
    return found.id;
  }
}

function isBulkReport(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && (Array.isArray(body.successes) || Array.isArray(body.failures));
}
