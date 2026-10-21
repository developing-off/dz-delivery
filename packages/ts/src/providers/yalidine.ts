/**
 * Yalidine Express provider.
 *
 * Checked against the Yalidine API v1 developer docs (merchant login required;
 * see docs/PROVIDERS.md). Error bodies are not documented and remain best-effort:
 *
 * - Base URL `https://api.yalidine.app/v1`, auth headers `X-API-ID` / `X-API-TOKEN`.
 * - List endpoints return `{ has_more, total_data, data: [...], links }` and accept
 *   `page` / `page_size` (1–1000, default 100).
 * - Errors are assumed to look like `{ error: { status_code, message } }`.
 * - Wilaya ids are the official codes `1`–`58`.
 * - Parcels are identified by their `tracking` (no separate internal id).
 * - Dates are `YYYY-MM-DD HH:mm:ss` in Algeria local time (UTC+1, no DST).
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser, type QueryValue } from '../http';
import { createStatusMapper } from '../status';
import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
  ParcelStatus,
  StopDesk,
  StopDeskQuery,
  TrackingEvent,
  TrackResult,
  YalidineConfig,
} from '../types';
import {
  findLocationByName,
  isRecord,
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

export const YALIDINE_DEFAULT_BASE_URL = 'https://api.yalidine.app/v1';
/** Same Yalidine platform under the GuepEx brand — use as `baseUrl` with the Yalidine provider. */
export const GUEPEX_DEFAULT_BASE_URL = 'https://api.guepex.app/v1';
const PROVIDER = 'yalidine';
const ALGERIA_OFFSET = '+01:00';
/** Guard against an API that keeps answering `has_more: true`. */
const MAX_PAGES = 50;
/** Largest `page_size` accepted by list endpoints (saves quota: 50 requests/minute). */
const PAGE_SIZE = 1000;
/** Weight included in the base price; each extra kg costs `oversize_fee`. */
const FREE_WEIGHT_KG = 5;
/** Volumetric weight (kg) = length × width × height (cm) × this factor. */
const VOLUMETRIC_FACTOR = 0.0002;

const IN_TRANSIT = [
  'ramasse', 'expedie', 'centre', 'enlocalisation', 'entransit', 'versstation', 'enstation', 'verswilaya', 'recuawilaya',
  'transfert', 'enattentedetransfert', 'pretpourlivreur', 'dispatche', 'sortienlivraison',
  'sortieenlivraison', 'enattentduclient', 'enattenteduclient', 'enattente',
  'tentativeechouee', 'echeclivraison', 'echecdelivraison', 'enalerte', 'alerteresolue',
  'bloque', 'debloque', 'enlivraison',
];

/**
 * Native status (French label) → unified status. Matching is case-, accent- and
 * separator-insensitive. MUST stay identical to the PHP `StatusMapper::yalidine`
 * (enforced by docs/fixtures/yalidine/statuses.json).
 */
export const mapYalidineStatus = createStatusMapper({
  exact: {
    enpreparation: 'pending',
    averifier: 'pending',
    pasencoreexpedie: 'created',
    pasencoreramasse: 'created',
    pretaexpedier: 'created',
    enpassation: 'created',
    livre: 'delivered',
    annule: 'cancelled',
    supprime: 'cancelled',
    echangeechoue: 'returned',
    colisabandonne: 'returned',
    ...Object.fromEntries(IN_TRANSIT.map((k) => [k, 'in_transit' as ParcelStatus])),
  },
  prefixes: [['retour', 'returned']],
});

const parseYalidineError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body } : undefined;
  const err = isRecord(body.error) ? body.error : body;
  return { message: str(err.message) ?? str(body.message) };
};

interface YPage<T> {
  has_more?: boolean;
  total_data?: number;
  data?: T[];
}

interface YWilaya {
  id: number | string;
  name: string;
  zone?: number;
  is_deliverable?: number | boolean;
}

interface YCommune {
  id: number | string;
  name: string;
  wilaya_id: number | string;
  wilaya_name?: string;
  has_stop_desk?: number | boolean;
  is_deliverable?: number | boolean;
}

interface YCenter {
  center_id: number | string;
  name?: string;
  address?: string | null;
  commune_id?: number | string;
  commune_name?: string;
  wilaya_id?: number | string;
  wilaya_name?: string;
}

interface YParcel {
  tracking: string;
  last_status?: string;
  date_last_status?: string;
}

interface YHistory {
  date_status: string;
  status: string;
  reason?: string | null;
}

interface YCreateResult {
  success?: boolean;
  order_id?: string;
  tracking?: string | null;
  message?: string;
}

interface YCommuneFees {
  commune_id?: number | string;
  commune_name?: string;
  express_home?: number | null;
  express_desk?: number | null;
}

interface YFees {
  retour_fee?: number | null;
  oversize_fee?: number | null;
  per_commune?: Record<string, YCommuneFees>;
}

/** `2025-12-30 13:24:34` (Algeria local time) → `2025-12-30T13:24:34+01:00`. */
export function yalidineDateToIso(value: string): string {
  return toIsoDate(value, ALGERIA_OFFSET);
}

function isDeliverable(flag: unknown): boolean {
  return flag === undefined || flag === null || Boolean(flag);
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** Yalidine requires integer dimensions / weight on every parcel: missing → 0, decimals rounded up. */
function intOrZero(value: number | undefined): number {
  return value === undefined ? 0 : Math.ceil(value);
}

/** Billable weight = max(actual weight, volumetric weight) when dimensions are known. */
function billableWeight(query: FeeQuery): number | undefined {
  const { weight, length, width, height } = query;
  const volumetric =
    length !== undefined && width !== undefined && height !== undefined
      ? length * width * height * VOLUMETRIC_FACTOR
      : undefined;
  if (weight === undefined) return volumetric;
  return volumetric === undefined ? weight : Math.max(weight, volumetric);
}

export class YalidineProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly includeRaw: boolean;
  private readonly fromWilayaId?: string | number;
  private readonly fromWilayaName?: string;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<Location[]>>();

  constructor(config: YalidineConfig) {
    if (!config?.apiId || !config?.apiToken) {
      throw new ShippingError('AUTH_FAILED', 'Yalidine requires `apiId` and `apiToken`', { provider: PROVIDER });
    }
    this.includeRaw = config.includeRaw ?? true;
    this.fromWilayaId = config.fromWilayaId;
    this.fromWilayaName = config.fromWilayaName;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl ?? YALIDINE_DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseYalidineError,
      headers: {
        'X-API-ID': config.apiId,
        'X-API-TOKEN': config.apiToken,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * `POST /parcels/` with a one-element array. Yalidine takes wilaya/commune **names**,
   * so ids are resolved to names first. The response is keyed by `order_id`.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    this.assertOriginConfigured();
    const phones = [normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone')];
    if (input.phone2) phones.push(normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2'));

    const to = await this.resolveWilaya(input.wilayaId ?? input.wilayaName!);
    const commune = await this.resolveCommune(to, input.communeId ?? input.communeName!);
    const from = await this.originWilaya();

    // Stop-desk: API rejects mismatch between stopdesk_id and to_commune_name /
    // to_wilaya_name (seen on GuepEx = same platform). Prefer the center's names.
    let toWilayaName = to.name;
    let toCommuneName = commune.name;
    if (input.isStopDesk) {
      const desk = String(input.stopDeskId).trim();
      const center = await this.findCenter(to.id, desk);
      if (center) {
        if (hasValue(center.wilaya_name)) toWilayaName = String(center.wilaya_name);
        if (hasValue(center.commune_name)) toCommuneName = String(center.commune_name);
        else if (hasValue(center.commune_id)) {
          toCommuneName = (await this.resolveCommune(to, center.commune_id!)).name;
        }
      }
    }

    const [firstname = '', ...rest] = input.recipientName.trim().split(/\s+/);
    const orderId = input.orderId?.trim() || `dzd-${randomUuid().replace(/-/g, '').slice(0, 12)}`;

    const parcel: Record<string, unknown> = {
      order_id: orderId,
      from_wilaya_name: from.name,
      firstname,
      familyname: rest.join(' ') || firstname,
      // Assumption: several numbers are accepted comma-separated.
      contact_phone: phones.join(','),
      address: input.address.trim(),
      to_commune_name: toCommuneName,
      to_wilaya_name: toWilayaName,
      product_list: productDescription(input),
      price: input.price,
      do_insurance: false,
      declared_value: input.price,
      length: intOrZero(input.length),
      width: intOrZero(input.width),
      height: intOrZero(input.height),
      weight: intOrZero(input.weight),
      // `price` is the full amount collected from the recipient (CONTRACT.md):
      // `freeshipping: true` stops Yalidine from adding its fee on top of it.
      freeshipping: true,
      is_stopdesk: Boolean(input.isStopDesk),
      has_exchange: false,
    };
    if (input.isStopDesk) {
      const desk = String(input.stopDeskId).trim();
      parcel.stopdesk_id = /^\d+$/.test(desk) ? Number(desk) : desk;
    }

    const res = await this.http.request<unknown>({ method: 'POST', path: '/parcels/', body: [parcel] });

    let result: YCreateResult | undefined;
    if (Array.isArray(res.body)) result = res.body[0] as YCreateResult | undefined;
    else if (isRecord(res.body)) result = (res.body[orderId] ?? Object.values(res.body)[0]) as YCreateResult | undefined;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Yalidine create response', {
        provider: PROVIDER,
        raw: res.body,
      });
    }
    if (result.success !== true || !result.tracking) {
      const message = result.message || 'Yalidine rejected the parcel';
      throw new ShippingError('VALIDATION_ERROR', message, {
        provider: PROVIDER,
        details: [{ message }],
        raw: res.body,
      });
    }

    // New Yalidine parcels start in "En préparation"; no follow-up read to save API quota.
    const tracking = String(result.tracking);
    return withRaw(
      { id: tracking, trackingNumber: tracking, status: 'pending' as const, provider: PROVIDER },
      result,
      this.includeRaw,
    );
  }

  /** `GET /parcels/{tracking}` + `GET /histories/{tracking}`. */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const native = await this.getParcel(tracking);
    const history = await this.list<YHistory>(`/histories/${encodeURIComponent(tracking)}`);
    const events: TrackingEvent[] = history.map((h) =>
      withRaw(
        {
          status: mapYalidineStatus(h.status),
          label: hasValue(h.reason) ? `${h.status ?? ''} (${h.reason})` : (h.status ?? ''),
          at: yalidineDateToIso(h.date_status),
        },
        h,
        this.includeRaw,
      ),
    );

    return {
      parcel: withRaw(
        {
          id: native.tracking,
          trackingNumber: native.tracking,
          status: mapYalidineStatus(native.last_status),
          provider: PROVIDER,
        },
        native,
        this.includeRaw,
      ),
      events: sortEventsAscending(events),
    };
  }

  /**
   * `GET /fees/?from_wilaya_id=&to_wilaya_id=`. Prices are per commune: uses
   * `toCommuneId` when given, otherwise the first commune returned. Uses the
   * `express_*` prices and adds `(billable weight − 5) × oversize_fee`, rounded up to the dinar.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }
    if (!hasValue(query.fromWilayaId)) this.assertOriginConfigured();

    const to = await this.resolveWilaya(query.toWilayaId);
    const from = hasValue(query.fromWilayaId) ? await this.resolveWilaya(query.fromWilayaId!) : await this.originWilaya();

    const res = await this.http.request<YFees>({
      method: 'GET',
      path: '/fees/',
      query: { from_wilaya_id: from.id, to_wilaya_id: to.id },
    });
    const fees = res.body;
    if (!isRecord(fees)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Yalidine fees response', {
        provider: PROVIDER,
        raw: fees,
      });
    }
    const perCommune = (isRecord(fees.per_commune) ? fees.per_commune : {}) as Record<string, YCommuneFees>;

    let commune: YCommuneFees | undefined;
    if (hasValue(query.toCommuneId)) {
      const wanted = String(query.toCommuneId).trim();
      commune = perCommune[wanted] ?? Object.values(perCommune).find((c) => String(c?.commune_id) === wanted);
    } else {
      commune = Object.values(perCommune)[0];
    }
    if (!isRecord(commune)) {
      throw new ShippingError('NOT_FOUND', 'No Yalidine rate for this destination', {
        provider: PROVIDER,
        raw: res.body,
      });
    }

    const home = num(commune.express_home);
    let desk = num(commune.express_desk ?? (commune as Record<string, unknown>).express_stopdesk);
    let deliveryFee = query.isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', 'No Yalidine rate for this delivery type', {
        provider: PROVIDER,
        raw: res.body,
      });
    }

    const oversize = num(res.body.oversize_fee);
    const weight = billableWeight(query);
    if (weight !== undefined && oversize !== undefined && weight > FREE_WEIGHT_KG) {
      // Round away float noise (e.g. 1.2000000000000002) before rounding up.
      const extra = Math.ceil(Math.round((weight - FREE_WEIGHT_KG) * oversize * 1e6) / 1e6);
      deliveryFee += extra;
      if (desk !== undefined) desk += extra;
    }

    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    const returnFee = num(res.body.retour_fee);
    if (returnFee !== undefined) quote.returnFee = returnFee;
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, res.body, this.includeRaw);
  }

  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.list<YWilaya>('/wilayas/')
      .then((items) =>
        items
          .filter((w) => isDeliverable(w.is_deliverable))
          .map((w) => withRaw({ id: String(w.id), name: w.name, code: String(w.id) }, w, this.includeRaw)),
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
   * `GET /centers/?wilaya_id=[&commune_id=]`. A center's `center_id` is the `stopdesk_id`
   * Yalidine expects for stop-desk parcels.
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    const wilaya = await this.resolveWilaya(query.wilayaId);
    const filter: Record<string, QueryValue> = { wilaya_id: wilaya.id };
    if (hasValue(query.communeId)) filter.commune_id = (await this.resolveCommune(wilaya, query.communeId!)).id;

    const centers = await this.list<YCenter>('/centers/', filter);
    return centers
      .filter((c) => hasValue(c?.center_id))
      .map((c) => {
        const desk: StopDesk = { id: String(c.center_id), name: String(c.name ?? '') };
        if (hasValue(c.address)) desk.address = String(c.address);
        if (hasValue(c.commune_id)) desk.communeId = String(c.commune_id);
        desk.wilayaId = hasValue(c.wilaya_id) ? String(c.wilaya_id) : wilaya.id;
        return withRaw(desk, c, this.includeRaw);
      });
  }

  /**
   * `DELETE /parcels/{tracking}`. Yalidine only deletes parcels still "En préparation";
   * a `deleted: false` answer is reported as `VALIDATION_ERROR`.
   */
  async listParcels(): Promise<never> {
    throw new ShippingError('NOT_SUPPORTED', 'Yalidine listParcels is not implemented yet', {
      provider: PROVIDER,
    });
  }

  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const tracking = trackingNumberOrId?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });
    const res = await this.http.request<unknown>({
      method: 'DELETE',
      path: `/parcels/${encodeURIComponent(tracking)}`,
    });
    const row = Array.isArray(res.body) ? res.body[0] : res.body;
    if (isRecord(row) && 'deleted' in row && !row.deleted) {
      throw new ShippingError(
        'VALIDATION_ERROR',
        'Yalidine refused to delete the parcel (only parcels "En préparation" can be deleted)',
        { provider: PROVIDER, httpStatus: res.status, raw: res.body },
      );
    }
  }

  /** Probes `GET /wilayas/` (bypasses cache). */
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

  private async getParcel(tracking: string): Promise<YParcel> {
    const res = await this.http.request<unknown>({
      method: 'GET',
      path: `/parcels/${encodeURIComponent(tracking)}`,
    });
    const body = res.body;
    const parcel = isRecord(body) && Array.isArray(body.data) ? body.data[0] : isRecord(body) && body.tracking ? body : undefined;
    if (!isRecord(parcel)) {
      throw new ShippingError('NOT_FOUND', `Parcel not found: ${tracking}`, { provider: PROVIDER, raw: body });
    }
    return parcel as unknown as YParcel;
  }

  private communesOf(wilayaId: string): Promise<Location[]> {
    let cached = this.communesCache.get(wilayaId);
    if (!cached) {
      cached = this.list<YCommune>('/communes/', { wilaya_id: wilayaId })
        .then((items) =>
          items
            .filter((c) => isDeliverable(c.is_deliverable))
            .map((c) =>
              withRaw({ id: String(c.id), name: c.name, parentId: String(c.wilaya_id ?? wilayaId) }, c, this.includeRaw),
            ),
        )
        .catch((err) => {
          this.communesCache.delete(wilayaId);
          throw err;
        });
      this.communesCache.set(wilayaId, cached);
    }
    return cached;
  }

  private async list<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.request<YPage<T> | T[]>({
        method: 'GET',
        path,
        query: { ...query, page, page_size: PAGE_SIZE },
      });
      const body = res.body;
      const data = Array.isArray(body) ? body : body?.data;
      if (!Array.isArray(data)) {
        throw new ShippingError('PROVIDER_ERROR', `Unexpected Yalidine response for ${path}`, {
          provider: PROVIDER,
          raw: body,
        });
      }
      all.push(...data);
      if (Array.isArray(body) || !body.has_more || data.length === 0) break;
    }
    return all;
  }

  private assertOriginConfigured(): void {
    if (!hasValue(this.fromWilayaId) && !hasValue(this.fromWilayaName)) {
      const message =
        'Yalidine needs the origin wilaya: set `fromWilayaId` or `fromWilayaName` in the client config (or pass fromWilayaId to getFees)';
      throw new ShippingError('VALIDATION_ERROR', message, {
        provider: PROVIDER,
        details: [{ field: 'fromWilayaId', message }],
      });
    }
  }

  private originWilaya(): Promise<Location> {
    this.assertOriginConfigured();
    return this.resolveWilaya(hasValue(this.fromWilayaId) ? this.fromWilayaId! : this.fromWilayaName!);
  }

  /** Accepts a Yalidine id / official code `1`–`58`, or a wilaya name. */
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

  /** `GET /centers/?wilaya_id=` then match `center_id` (Yalidine's `stopdesk_id`). */
  private async findCenter(wilayaId: string, stopDeskId: string): Promise<YCenter | undefined> {
    const wanted = stopDeskId.trim();
    const centers = await this.list<YCenter>('/centers/', { wilaya_id: wilayaId });
    return centers.find((c) => hasValue(c?.center_id) && String(c.center_id) === wanted);
  }
}
