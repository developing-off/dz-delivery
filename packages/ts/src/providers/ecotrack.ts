/**
 * Ecotrack provider — one implementation for every courier running on the Ecotrack
 * platform (DHD, Anderson, World Express, 48Hr, EcoRapid, Conexlog, …).
 *
 * Built from Postman notes + Delivery/Ecotrack.php tenant hosts
 * (docs/vendor/ecotrack/; mapping in docs/PROVIDERS.md#ecotrack):
 *
 * - Each courier hosts the same API on its own domain; endpoints under `/api/v1`.
 *   Auth header `Authorization: Bearer <token>`.
 * - Single-order endpoints take query parameters, never a JSON body.
 * - Business failures come back as HTTP 200 `{ success: false, error: 1000x }`,
 *   validation failures as HTTP 422 Laravel `{ message, errors: { field: [..] } }`.
 * - Orders stay "prêt à expédier" until validated (`POST valid/order`): see `autoValidate`.
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser, type HttpResponse } from '../http';
import { createStatusMapper } from '../status';
import type {
  EcotrackConfig,
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
  ParcelStatus,
  ShippingErrorCode,
  ShippingErrorDetail,
  StopDesk,
  StopDeskQuery,
  TrackingEvent,
  TrackResult,
} from '../types';
import {
  findLocationByName,
  isRecord,
  isWilayaCode,
  normalizeAlgerianPhone,
  productDescription,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

const PROVIDER = 'ecotrack';
const API_PREFIX = '/api/v1';
const ALGERIA_OFFSET = '+01:00';
const ORDER_TYPE_DELIVERY = 1;
const NOTIFICATION = 'notification_on_order';

/**
 * Built-in tenant hosts for `courier: '<key>'`. Keys follow the Ecotrack courier key table
 * of the integration notes; hosts not confirmed by a courier are listed in PROVIDERS.md.
 * Any other tenant works with `baseUrl`.
 */
export const ECOTRACK_COURIERS: Readonly<Record<string, string>> = {
  // Hosts confirmed in Delivery/Ecotrack.php EntrepriseName (production tenants).
  dhd: 'https://platform.dhd-dz.com',
  anderson: 'https://anderson-ecommerce.ecotrack.dz',
  andersondelivery: 'https://anderson-ecommerce.ecotrack.dz', // alias
  worldexpress: 'https://world-express.ecotrack.dz',
  '48hrexpress': 'https://48hr.ecotrack.dz',
  ecorapid: 'https://ecorapide-express.ecotrack.dz',
  // Hosts from Ecotrack integration notes (not in Delivery; use baseUrl if wrong).
  conexlog: 'https://app.conexlog-dz.com',
  msmgo: 'https://msmgo.ecotrack.dz',
  packers: 'https://packers.ecotrack.dz',
  rocketdelivery: 'https://rocketdelivery.ecotrack.dz',
};

/**
 * Tenant host from `{ baseUrl }` or `{ courier }` (exactly one). Only `https` URLs are
 * accepted; a trailing `/api/v1` is stripped. Throws `VALIDATION_ERROR`.
 */
export function resolveEcotrackBaseUrl(config: { baseUrl?: string; courier?: string }): string {
  const baseUrl = config?.baseUrl?.trim();
  const courier = config?.courier?.trim().toLowerCase();
  if (!baseUrl === !courier) {
    throw new ShippingError('VALIDATION_ERROR', 'Ecotrack requires exactly one of `baseUrl` (tenant URL) or `courier`', {
      provider: PROVIDER,
      details: [{ field: 'baseUrl', message: 'Exactly one of baseUrl / courier is required' }],
    });
  }
  if (courier) {
    const host = ECOTRACK_COURIERS[courier];
    if (!host) {
      throw new ShippingError(
        'VALIDATION_ERROR',
        `Unknown Ecotrack courier "${courier}". Known: ${Object.keys(ECOTRACK_COURIERS).join(', ')}; ` +
          'pass the tenant URL as `baseUrl` instead',
        { provider: PROVIDER, details: [{ field: 'courier', message: `Unknown Ecotrack courier "${courier}"` }] },
      );
    }
    return host;
  }
  let url: URL | undefined;
  try {
    url = new URL(baseUrl!);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new ShippingError('VALIDATION_ERROR', `Ecotrack baseUrl must be an https URL, got "${baseUrl}"`, {
      provider: PROVIDER,
      details: [{ field: 'baseUrl', message: 'baseUrl must be an https URL' }],
    });
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  return url.origin + path;
}

const mapEcotrackKey = createStatusMapper({
  exact: {
    // Activity keys (get/tracking/info `activity[].status`).
    order_information_received_by_carrier: 'created',
    picked: 'in_transit',
    accepted_by_carrier: 'in_transit',
    dispatched_to_driver: 'in_transit',
    attempt_delivery: 'in_transit',
    livred: 'delivered',
    encaissed: 'delivered',
    payed: 'delivered',
    return_asked: 'returned',
    return_in_transit: 'returned',
    return_received: 'returned',
    // Order status enum keys (get/orders `status`, get/orders/status filter).
    prete_a_expedier: 'pending',
    prete_a_preparer: 'pending',
    en_preparation_stock: 'created',
    en_ramassage: 'created',
    vers_hub: 'in_transit',
    en_hub: 'in_transit',
    vers_wilaya: 'in_transit',
    en_preparation: 'in_transit',
    en_livraison: 'in_transit',
    suspendu: 'in_transit',
    livre_non_encaisse: 'delivered',
    encaisse_non_paye: 'delivered',
    paiements_prets: 'delivered',
    paye_et_archive: 'delivered',
    retour_chez_livreur: 'returned',
    retour_transit_entrepot: 'returned',
    retour_en_traitement: 'returned',
    retour_recu: 'returned',
    retour_archive: 'returned',
    annule: 'cancelled',
  },
});

/**
 * Ecotrack activity key (`livred`, `Return_received`, ...) or order status enum key
 * (`en_livraison`, `annule`, ...) → unified status. French display labels drift per
 * tenant and are deliberately not mapped; `notification_on_order` (a remark) is not a
 * status. MUST stay identical to the PHP `StatusMapper::ecotrack`
 * (enforced by docs/fixtures/ecotrack/statuses.json).
 */
export function mapEcotrackStatus(native: string | null | undefined): ParcelStatus {
  return mapEcotrackKey(native);
}

/** Business error code → [unified code, message, ParcelInput field]. */
const BUSINESS_ERRORS: Record<number, [ShippingErrorCode, string, string?]> = {
  10001: ['VALIDATION_ERROR', 'Order can no longer be modified (already validated)'],
  10002: ['VALIDATION_ERROR', 'No delivery to the selected wilaya', 'wilayaId'],
  10003: ['VALIDATION_ERROR', 'A return cannot be requested for this order'],
};

const parseEcotrackError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : undefined;
  const details: ShippingErrorDetail[] = [];
  if (isRecord(body.errors)) {
    for (const [field, value] of Object.entries(body.errors)) {
      for (const m of Array.isArray(value) ? value : [value]) if (typeof m === 'string') details.push({ field, message: m });
    }
  }
  const message = details.length > 0 ? details.map((d) => d.message).join('; ') : (str(body.message) ?? str(body.error));
  return { message, details };
};

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** Values of a JSON list or of an index-keyed object (`{ "0": {...}, "1": {...} }`). */
function entries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

/**
 * Tracking from `create/order` — some tenants nest it under `data` / `data.order` / `order`
 * (see Delivery/Ecotrack.php `extractEcotrackCreateOrderTracking`).
 */
function extractCreateOrderTracking(body: unknown): string | undefined {
  const keys = ['tracking', 'tracking_number', 'tracking_id', 'numero_tracking', 'n_tracking', 'track'];
  const from = (node: unknown): string | undefined => {
    if (!isRecord(node)) return undefined;
    for (const key of keys) {
      if (hasValue(node[key])) return String(node[key]).trim();
    }
    return undefined;
  };
  if (!isRecord(body)) return undefined;
  return (
    from(body) ??
    (isRecord(body.data) ? (from(body.data) ?? from(body.data.order)) : undefined) ??
    from(body.order)
  );
}

/** `{ success: false, error, message }` (HTTP 200) → ShippingError. */
function businessError(body: Record<string, unknown>, httpStatus: number, raw: unknown): ShippingError {
  const nativeCode = hasValue(body.error) && /^\d+$/.test(String(body.error).trim()) ? Number(body.error) : undefined;
  const known = nativeCode !== undefined ? BUSINESS_ERRORS[nativeCode] : undefined;
  const message = str(body.message) || known?.[1] || (typeof body.error === 'string' ? body.error : '') || 'Ecotrack rejected the request';
  const detail: ShippingErrorDetail = known?.[2] ? { field: known[2], message } : { message };
  if (nativeCode !== undefined) detail.code = String(nativeCode);
  return new ShippingError(known?.[0] ?? 'PROVIDER_ERROR', message, {
    httpStatus,
    details: [detail],
    raw,
    provider: PROVIDER,
  });
}

/** A 422 whose only invalid field is `tracking` means the tracking number does not exist. */
function asTrackingNotFound(err: unknown, tracking: string): unknown {
  if (
    err instanceof ShippingError &&
    err.httpStatus === 422 &&
    Array.isArray(err.details) &&
    err.details.length > 0 &&
    err.details.every((d) => d.field === 'tracking')
  ) {
    return new ShippingError('NOT_FOUND', `Unknown Ecotrack tracking number: ${tracking}`, {
      httpStatus: 422,
      details: err.details,
      raw: err.raw,
      provider: PROVIDER,
    });
  }
  return err;
}

export class EcotrackProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly includeRaw: boolean;
  private readonly autoValidate: boolean;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<Array<{ location: Location; stopDesk: boolean }>>>();

  constructor(config: EcotrackConfig) {
    const token = config?.token?.trim().replace(/^bearer\s+/i, '');
    if (!token) {
      throw new ShippingError('AUTH_FAILED', 'Ecotrack requires `token`', { provider: PROVIDER });
    }
    const tenant = resolveEcotrackBaseUrl(config);
    this.includeRaw = config.includeRaw ?? true;
    this.autoValidate = config.autoValidate ?? false;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: tenant + API_PREFIX,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseEcotrackError,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  }

  /**
   * `POST /create/order` with query parameters. The commune is resolved to the tenant's
   * spelling through `get/communes`. With `autoValidate`, `POST /valid/order` follows.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const phone2 = input.phone2 ? normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2') : undefined;

    const wilayaCode = await this.resolveWilayaCode(input.wilayaId ?? input.wilayaName!);
    const commune = await this.resolveCommune(wilayaCode, input.communeId ?? input.communeName!);

    const query: Record<string, string | number> = {
      nom_client: input.recipientName.trim(),
      telephone: phone,
      adresse: input.address.trim(),
      code_wilaya: Number(wilayaCode),
      commune: commune.name,
      // `montant` includes the delivery fee: it is exactly what the recipient pays.
      montant: Math.round(input.price),
      produit: productDescription(input),
      type: ORDER_TYPE_DELIVERY,
      stop_desk: input.isStopDesk ? 1 : 0,
    };
    if (phone2) query.telephone_2 = phone2;
    if (input.isStopDesk) query.code_postal = String(input.stopDeskId).trim();
    if (input.weight !== undefined) query.weight = input.weight;
    if (input.remark?.trim()) query.remarque = input.remark.trim();
    if (input.orderId?.trim()) query.reference = input.orderId.trim();

    const res = await this.http.request<unknown>({ method: 'POST', path: '/create/order', query });
    const body = res.body;
    if (isRecord(body) && body.success === false) throw businessError(body, res.status, body);
    if (isRecord(body) && body.status === 'error') {
      throw new ShippingError('PROVIDER_ERROR', str(body.message) || 'Ecotrack rejected the request', {
        provider: PROVIDER,
        raw: body,
        httpStatus: res.status,
      });
    }
    const tracking = extractCreateOrderTracking(body);
    if (!tracking) {
      throw new ShippingError('PROVIDER_ERROR', 'Ecotrack did not return a tracking number', { provider: PROVIDER, raw: body });
    }
    let status: ParcelStatus = 'pending';
    if (this.autoValidate) {
      await this.validateOrder(tracking);
      status = 'created';
    }
    return withRaw({ id: tracking, trackingNumber: tracking, status, provider: PROVIDER }, body, this.includeRaw);
  }

  /**
   * `GET /get/tracking/info?tracking=`. Only the entry for this exact tracking number is
   * used. `notification_on_order` (a remark) keeps the previous status; no activity yet
   * means the order is not validated (`pending`).
   */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    let body: unknown;
    try {
      body = (await this.http.request<unknown>({ method: 'GET', path: '/get/tracking/info', query: { tracking } })).body;
    } catch (err) {
      throw asTrackingNotFound(err, tracking);
    }
    const info = this.pickTrackingInfo(body, tracking);

    const rows = entries(info.activity)
      .filter(isRecord)
      .filter((a) => !hasValue(a.tracking) || String(a.tracking).trim() === tracking)
      .map((a, i) => {
        const date = String(a.date ?? '').trim();
        const time = String(a.time ?? '').trim();
        return { a, i, at: toIsoDate(date && !/[T ]\d/.test(date) ? `${date} ${time || '00:00:00'}` : date, ALGERIA_OFFSET) };
      })
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i));

    let current: ParcelStatus = 'pending';
    const events: TrackingEvent[] = rows.map(({ a, at }) => {
      const key = String(a.status ?? '').trim();
      if (key !== NOTIFICATION) current = mapEcotrackStatus(key);
      const label = hasValue(a.reason) ? `${key} (${String(a.reason).trim()})` : key;
      return withRaw({ status: current, label, at }, a, this.includeRaw);
    });

    return {
      parcel: withRaw({ id: tracking, trackingNumber: tracking, status: current, provider: PROVIDER }, info, this.includeRaw),
      events,
    };
  }

  /**
   * `GET /get/fees`: per-wilaya `livraison` (home `tarif`, `tarif_stopdesk`) and `retours`
   * rows for the account. A `0` delivery price means the mode is not offered.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }
    const code = Number(await this.resolveWilayaCode(query.toWilayaId));

    const res = await this.http.request<unknown>({ method: 'GET', path: '/get/fees' });
    const body = res.body;
    if (!isRecord(body) || body.livraison === undefined) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Ecotrack fees response', { provider: PROVIDER, raw: body });
    }
    const rowOf = (list: unknown) =>
      entries(list).find((r): r is Record<string, unknown> => isRecord(r) && Number(r.wilaya_id) === code);
    const positive = (v: unknown) => {
      const n = num(v);
      return n !== undefined && n > 0 ? n : undefined;
    };

    const delivery = rowOf(body.livraison);
    const home = positive(delivery?.tarif);
    const desk = positive(delivery?.tarif_stopdesk);
    const deliveryFee = query.isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', `No Ecotrack ${query.isStopDesk ? 'stop-desk' : 'home'} rate for wilaya ${code}`, {
        provider: PROVIDER,
        raw: body,
      });
    }

    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    const returns = rowOf(body.retours ?? body.retour);
    const returnFee = num(query.isStopDesk ? returns?.tarif_stopdesk : returns?.tarif);
    if (returnFee !== undefined) quote.returnFee = returnFee;
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, body, this.includeRaw);
  }

  /** `GET /get/wilayas`: only the wilayas this tenant delivers to. */
  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.http
      .request<unknown>({ method: 'GET', path: '/get/wilayas' })
      .then(({ body }) => {
        const items = isRecord(body) && body.data !== undefined ? body.data : body;
        if (!Array.isArray(items) && !isRecord(items)) {
          throw new ShippingError('PROVIDER_ERROR', 'Unexpected Ecotrack wilayas response', { provider: PROVIDER, raw: body });
        }
        return entries(items).flatMap((w) => {
          if (!isRecord(w) || !hasValue(w.wilaya_id)) return [];
          const id = String(w.wilaya_id).trim();
          return [withRaw({ id, name: String(w.wilaya_name ?? ''), code: id }, w, this.includeRaw)];
        });
      })
      .catch((err) => {
        this.wilayasCache = undefined;
        throw err;
      });
    return this.wilayasCache;
  }

  /** `GET /get/communes?wilaya_id=` (an index-keyed object, not a list). */
  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    const code = await this.resolveWilayaCode(wilayaId);
    return (await this.communesOf(code)).map((c) => c.location);
  }

  /**
   * Communes flagged `has_stop_desk: 1`. The desk `id` is the commune's `code_postal`
   * (Ecotrack "station code"), sent back as `code_postal` by `createParcel`.
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    const code = await this.resolveWilayaCode(query.wilayaId);
    let communes = await this.communesOf(code);
    if (hasValue(query.communeId)) {
      const commune = await this.resolveCommune(code, query.communeId!);
      communes = communes.filter((c) => c.location.id === commune.id);
    }
    return communes
      .filter((c) => c.stopDesk && hasValue(c.location.code))
      .map(({ location }) =>
        withRaw(
          { id: location.code!, name: location.name, communeId: location.id, wilayaId: code },
          location.raw,
          this.includeRaw,
        ),
      );
  }

  /**
   * `DELETE /delete/order?tracking=`. Ecotrack only deletes orders that are not validated
   * yet; afterwards (error 10001) this throws `VALIDATION_ERROR`.
   */
  async listParcels(): Promise<never> {
    throw new ShippingError('NOT_SUPPORTED', 'Ecotrack listParcels is not implemented yet', {
      provider: PROVIDER,
    });
  }

  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const tracking = trackingNumberOrId?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });

    let res: HttpResponse<unknown>;
    try {
      res = await this.http.request<unknown>({ method: 'DELETE', path: '/delete/order', query: { tracking } });
    } catch (err) {
      throw asTrackingNotFound(err, tracking);
    }
    const body = res.body;
    if (isRecord(body) && body.success === false) {
      const err = businessError(body, res.status, body);
      if (Array.isArray(err.details) && err.details[0]?.code === '10001') {
        throw new ShippingError(
          'VALIDATION_ERROR',
          `Ecotrack order ${tracking} cannot be cancelled: it has already been validated (only orders not yet validated can be deleted)`,
          { httpStatus: res.status, details: err.details, raw: body, provider: PROVIDER },
        );
      }
      throw err;
    }
    if (isRecord(body) && body.delete === 'fail') {
      throw new ShippingError('VALIDATION_ERROR', `Ecotrack refused to delete order ${tracking} (already validated?)`, {
        httpStatus: res.status,
        raw: body,
        provider: PROVIDER,
      });
    }
  }

  /** Probes `GET /get/wilayas` (bypasses cache). */
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

  /** `POST /valid/order?tracking=` — hands the order over to the courier. */
  private async validateOrder(tracking: string): Promise<void> {
    try {
      const res = await this.http.request<unknown>({ method: 'POST', path: '/valid/order', query: { tracking } });
      if (isRecord(res.body) && res.body.success === false) throw businessError(res.body, res.status, res.body);
    } catch (err) {
      if (!(err instanceof ShippingError)) throw err;
      throw new ShippingError(
        err.code,
        `Ecotrack order ${tracking} was created but could not be validated: ${err.message}`,
        { httpStatus: err.httpStatus, details: err.details, raw: err.raw, provider: PROVIDER, retryAfter: err.retryAfter },
      );
    }
  }

  /**
   * The tracking info object for exactly `tracking`. Tolerates list-style answers and
   * objects keyed by tracking number; never takes "the first row" of a list.
   */
  private pickTrackingInfo(body: unknown, tracking: string): Record<string, unknown> {
    const notFound = () =>
      new ShippingError('NOT_FOUND', `Unknown Ecotrack tracking number: ${tracking}`, { provider: PROVIDER, raw: body });
    const root = isRecord(body) && body.data !== undefined && body.activity === undefined ? body.data : body;
    if (Array.isArray(root)) {
      const found = root.find((r) => isRecord(r) && hasValue(r.tracking) && String(r.tracking).trim() === tracking);
      if (!isRecord(found)) throw notFound();
      return found;
    }
    if (!isRecord(root)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected Ecotrack tracking response', { provider: PROVIDER, raw: body });
    }
    if (root.activity === undefined && isRecord(root[tracking])) return root[tracking] as Record<string, unknown>;
    if (root.activity === undefined) throw notFound();
    if (hasValue(root.tracking) && String(root.tracking).trim() !== tracking) throw notFound();
    return root;
  }

  private communesOf(wilayaCode: string): Promise<Array<{ location: Location; stopDesk: boolean }>> {
    let cached = this.communesCache.get(wilayaCode);
    if (!cached) {
      cached = this.http
        .request<unknown>({ method: 'GET', path: '/get/communes', query: { wilaya_id: wilayaCode } })
        .then(({ body }) => {
          if (!Array.isArray(body) && !isRecord(body)) {
            throw new ShippingError('PROVIDER_ERROR', 'Unexpected Ecotrack communes response', { provider: PROVIDER, raw: body });
          }
          return entries(body).flatMap((c) => {
            if (!isRecord(c) || !hasValue(c.nom)) return [];
            if (hasValue(c.wilaya_id) && Number(c.wilaya_id) !== Number(wilayaCode)) return [];
            const name = String(c.nom).trim();
            const location: Location = {
              id: hasValue(c.code_postal) ? String(c.code_postal).trim() : name,
              name,
              parentId: wilayaCode,
            };
            if (hasValue(c.code_postal)) location.code = String(c.code_postal).trim();
            return [{ location: withRaw(location, c, this.includeRaw), stopDesk: Number(c.has_stop_desk) === 1 }];
          });
        })
        .catch((err) => {
          this.communesCache.delete(wilayaCode);
          throw err;
        });
      this.communesCache.set(wilayaCode, cached);
    }
    return cached;
  }

  /** Official code `1`–`58` as-is (Ecotrack ids are the codes); names via `get/wilayas`. */
  private async resolveWilayaCode(ref: string | number): Promise<string> {
    const value = String(ref).trim();
    if (isWilayaCode(value)) return String(Number(value));
    const found = /^\d+$/.test(value) ? undefined : findLocationByName(await this.getWilayas(), value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${value}`, { provider: PROVIDER });
    return found.id;
  }

  private async resolveCommune(wilayaCode: string, ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const communes = (await this.communesOf(wilayaCode)).map((c) => c.location);
    const found = communes.find((c) => c.id === value) ?? findLocationByName(communes, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilayaCode}`, { provider: PROVIDER });
    }
    return found;
  }
}
