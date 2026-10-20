import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper } from '../status';
import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
  ParcelStatus,
  ShippingErrorDetail,
  StopDesk,
  StopDeskQuery,
  TrackingEvent,
  TrackResult,
  ZRExpressConfig,
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
    Delivered: 'delivered',
    livre: 'delivered',
    livree: 'delivered',
    Cancelled: 'cancelled',
    Canceled: 'cancelled',
    annule: 'cancelled',
    annulee: 'cancelled',
    deleted: 'cancelled',
    supprime: 'cancelled',
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
    validateParcelInput(input, PROVIDER);
    const phone: Record<string, string> = {
      number1: normalizeAlgerianPhone(input.phone, 'international', PROVIDER, 'phone'),
    };
    if (input.phone2) phone.number2 = normalizeAlgerianPhone(input.phone2, 'international', PROVIDER, 'phone2');

    const wilaya = await this.resolveWilaya(input.wilayaId ?? input.wilayaName!);
    const communeId = await this.resolveCommuneId(wilaya.id, input);

    const orderedProducts = input.productList
      ? input.productList.map((p) => ({
          productName: p.name,
          quantity: p.quantity,
          // Assumption: ZRExpress requires a unit price; 0 when the merchant did not provide one.
          unitPrice: p.unitPrice ?? 0,
          ...(p.sku ? { productSku: p.sku } : {}),
          stockType: 'none',
        }))
      : [{ productName: input.productName!.trim(), quantity: 1, unitPrice: input.price, stockType: 'none' }];

    // No parcel-level dimensions: applied to the first product (docs/PROVIDERS.md).
    const first = orderedProducts[0] as Record<string, unknown>;
    if (input.length !== undefined) first.length = input.length;
    if (input.width !== undefined) first.width = input.width;
    if (input.height !== undefined) first.height = input.height;

    const body: Record<string, unknown> = {
      customer: { customerId: randomUuid(), name: input.recipientName.trim(), phone },
      deliveryAddress: { street: input.address.trim(), cityTerritoryId: wilaya.id, districtTerritoryId: communeId },
      orderedProducts,
      deliveryType: input.isStopDesk ? 'pickup-point' : 'home',
      amount: input.price,
      description: productDescription(input).slice(0, 250),
    };
    if (input.isStopDesk) body.hubId = input.stopDeskId;
    if (input.weight !== undefined) body.weight = { weight: input.weight };
    if (input.orderId) body.externalId = input.orderId;

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

  /** Not available yet: the ZRExpress hub listing endpoint is not documented. Pass the hub UUID as `stopDeskId`. */
  async getStopDesks(_query: StopDeskQuery): Promise<StopDesk[]> {
    throw new ShippingError(
      'NOT_SUPPORTED',
      'ZRExpress hub listing is not supported yet; pass the hub UUID as stopDeskId',
      { provider: PROVIDER },
    );
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
      const value = String(input.communeId).trim();
      if (isUuid(value)) return value;
      // Non-UUID id: treat it as a commune code / postal code within the wilaya.
      const communes = await this.getCommunes(wilayaId);
      const found = communes.find((c) => c.code === value);
      if (!found) throw new ShippingError('NOT_FOUND', `Unknown ZRExpress commune "${value}"`, { provider: PROVIDER });
      return found.id;
    }
    const communes = await this.getCommunes(wilayaId);
    const found = findLocationByName(communes, input.communeName!);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown ZRExpress commune "${input.communeName}"`, { provider: PROVIDER });
    }
    return found.id;
  }
}
