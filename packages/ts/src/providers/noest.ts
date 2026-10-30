/**
 * NOEST provider — `app.noest-dz.com/api/public`.
 *
 * Built from the NOEST Public API documentation v2.3 (May 2026) and checked against live
 * read-only responses (mapping in docs/PROVIDERS.md#noest):
 *
 * - Auth header `Authorization: Bearer <api_token>`; the partner `user_guid` goes in every
 *   POST body. GET endpoints need the token only.
 * - Validation failures come back as HTTP 422 Laravel `{ message, errors: { field: [..] } }`,
 *   some business failures as HTTP 200 `{ success: false, ... }`.
 * - Orders stay editable until validated (`POST valid/order`): see `autoValidate`.
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser, type HttpResponse } from '../http';
import { createStatusMapper, normalizeStatusKey } from '../status';
import type {
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  NoestConfig,
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

const PROVIDER = 'noest';
export const NOEST_DEFAULT_BASE_URL = 'https://app.noest-dz.com';
const API_PREFIX = '/api/public';
const ALGERIA_OFFSET = '+01:00';
const ORDER_TYPE_DELIVERY = 1;

/** Events that annotate an order (edits, surcharges) without changing where it is. */
const REMARK_EVENTS = new Set(['edited_informations', 'edit_price', 'edit_wilaya', 'extra_fee'].map(normalizeStatusKey));

const mapNoestKey = createStatusMapper({
  exact: {
    // Event keys (get/trackings/info `activity[].event_key`).
    upload: 'pending',
    customer_validation: 'created',
    validation_collect_colis: 'in_transit',
    validation_reception_admin: 'in_transit',
    validation_reception: 'in_transit',
    fdr_activated: 'in_transit',
    sent_to_redispatch: 'in_transit',
    nouvel_tentative_asked_by_customer: 'in_transit',
    mise_a_jour: 'in_transit',
    colis_suspendu: 'in_transit',
    return_redispatched_to_livraison: 'in_transit',
    pickedup: 'in_transit',
    valid_return_pickup: 'in_transit',
    livre: 'delivered',
    livred: 'delivered',
    verssement_admin_cust: 'delivered',
    verssement_admin_cust_canceled: 'delivered',
    verssement_hub_cust_canceled: 'delivered',
    validation_reception_cash_by_partener: 'delivered',
    echange_valide: 'delivered',
    echange_valid_by_hub: 'delivered',
    // Pick-up orders (type 3) end when the collected package reaches the partner.
    pickup_picked_recu: 'delivered',
    colis_pickup_transmit_to_partner: 'delivered',
    return_asked_by_customer: 'returned',
    return_asked_by_hub: 'returned',
    retour_dispatched_to_partenaires: 'returned',
    return_dispatched_to_partenaire: 'returned',
    colis_retour_transmit_to_partner: 'returned',
    annulation_dispatch_retour: 'returned',
    cancel_return_dispatched_to_partenaire: 'returned',
    livraison_echoue_recu: 'returned',
    return_validated_by_partener: 'returned',
    return_dispatched_to_warehouse: 'returned',
    ask_to_delete_by_admin: 'cancelled',
    ask_to_delete_by_hub: 'cancelled',
    // English event labels (`activity[].event`), used when `event_key` is missing.
    'Uploaded to system': 'pending',
    Validated: 'created',
    'Package Picked Up': 'in_transit',
    'Reception validated': 'in_transit',
    'Picked up by driver': 'in_transit',
    'Out for delivery': 'in_transit',
    'Sent for redispatch': 'in_transit',
    'New attempt requested by seller': 'in_transit',
    'Delivery attempt': 'in_transit',
    Suspended: 'in_transit',
    'Return put back for delivery': 'in_transit',
    Delivered: 'delivered',
    'Amount transmitted to partner': 'delivered',
    'Amount received by partner': 'delivered',
    'Exchange validated': 'delivered',
    'Exchange validated by hub': 'delivered',
    'Return requested by partner': 'returned',
    'Return in transit': 'returned',
    'Return dispatched to partner': 'returned',
    'Return package transmitted to partner': 'returned',
    'Return received by partner': 'returned',
    'Return validated by partner': 'returned',
    'Return dispatched to warehouse': 'returned',
    'Deletion requested': 'cancelled',
  },
});

/**
 * NOEST event key (`livred`, `return_asked_by_hub`, ...) or English event label
 * (`Delivered`, ...) → unified status. Remark events (`edit_price`, ...) map to `unknown`.
 * MUST stay identical to the PHP `StatusMapper::noest`
 * (enforced by docs/fixtures/noest/statuses.json).
 */
export function mapNoestStatus(native: string | null | undefined): ParcelStatus {
  return mapNoestKey(native);
}

/** Business error codes from the documentation → unified code. */
const BUSINESS_ERRORS: Record<string, ShippingErrorCode> = {
  account_suspended: 'AUTH_FAILED',
  duplicate_order: 'VALIDATION_ERROR',
  inactive_commune: 'VALIDATION_ERROR',
  zip_code: 'VALIDATION_ERROR',
  max_amount_exceeded: 'VALIDATION_ERROR',
  stopdesk_disabled: 'VALIDATION_ERROR',
  station_expedition: 'VALIDATION_ERROR',
  station_code: 'VALIDATION_ERROR',
  disabled_module: 'VALIDATION_ERROR',
  wrong_quantities: 'VALIDATION_ERROR',
  invalid_product: 'VALIDATION_ERROR',
  out_of_stock: 'VALIDATION_ERROR',
  already_validated: 'VALIDATION_ERROR',
};

/** NOEST field → ParcelInput field, for 422 details. */
const FIELDS: Record<string, string> = {
  client: 'recipientName',
  phone: 'phone',
  phone_2: 'phone2',
  adresse: 'address',
  wilaya_id: 'wilayaId',
  commune: 'communeId',
  montant: 'price',
  produit: 'productName',
  poids: 'weight',
  station_code: 'stopDeskId',
  remarque: 'remark',
  reference: 'orderId',
};

function collectDetails(errors: unknown): ShippingErrorDetail[] {
  const details: ShippingErrorDetail[] = [];
  if (!isRecord(errors)) return details;
  for (const [field, value] of Object.entries(errors)) {
    for (const m of Array.isArray(value) ? value : [value]) {
      if (typeof m === 'string') details.push({ field: FIELDS[field] ?? field, message: m });
    }
  }
  return details;
}

const parseNoestError: ErrorBodyParser = (body) => {
  if (!isRecord(body)) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : undefined;
  const details = collectDetails(body.errors);
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

/** Values of a JSON list or of a keyed object (`{ "16": {...} }`, `{ "01A": {...} }`). */
function entries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

function isActive(row: Record<string, unknown>): boolean {
  return !hasValue(row.is_active) || Number(row.is_active) === 1;
}

/** `{ success: false, ... }` (HTTP 200) → ShippingError. */
function businessError(body: Record<string, unknown>, httpStatus: number, fallback: string): ShippingError {
  const nativeCode = [body.code, body.error_code, body.error].map(str).find((v) => v && BUSINESS_ERRORS[v]);
  const details = collectDetails(body.errors);
  const message =
    str(body.message) ||
    (details.length > 0 ? details.map((d) => d.message).join('; ') : undefined) ||
    (typeof body.error === 'string' ? body.error : '') ||
    fallback;
  if (details.length === 0) details.push(nativeCode ? { message, code: nativeCode } : { message });
  return new ShippingError(nativeCode ? BUSINESS_ERRORS[nativeCode]! : 'PROVIDER_ERROR', message, {
    httpStatus,
    details,
    raw: body,
    provider: PROVIDER,
  });
}

export class NoestProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly userGuid: string;
  private readonly includeRaw: boolean;
  private readonly autoValidate: boolean;
  private wilayasCache?: Promise<Location[]>;
  private desksCache?: Promise<Array<{ desk: StopDesk; commune: string }>>;
  private readonly communesCache = new Map<string, Promise<Location[]>>();

  constructor(config: NoestConfig) {
    const token = config?.apiToken?.trim().replace(/^bearer\s+/i, '');
    const userGuid = config?.userGuid?.trim();
    if (!token || !userGuid) {
      throw new ShippingError('AUTH_FAILED', 'NOEST requires `apiToken` and `userGuid`', { provider: PROVIDER });
    }
    this.userGuid = userGuid;
    this.includeRaw = config.includeRaw ?? true;
    this.autoValidate = config.autoValidate ?? false;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: (config.baseUrl?.trim() || NOEST_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/api\/public$/i, '') + API_PREFIX,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseNoestError,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
  }

  /**
   * `POST /create/order`. The commune is resolved to NOEST's spelling through
   * `get/communes/{wilaya}`. With `autoValidate`, `POST /valid/order` follows.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const phone2 = input.phone2 ? normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2') : undefined;

    const wilayaCode = await this.resolveWilayaCode(input.wilayaId ?? input.wilayaName!);
    const commune = await this.resolveCommune(wilayaCode, input.communeId ?? input.communeName!);

    const body: Record<string, unknown> = {
      user_guid: this.userGuid,
      client: input.recipientName.trim(),
      phone,
      adresse: input.address.trim(),
      wilaya_id: Number(wilayaCode),
      commune: commune.name,
      // `montant` includes the delivery fee: it is exactly what the recipient pays.
      montant: Math.round(input.price),
      produit: productDescription(input),
      type_id: ORDER_TYPE_DELIVERY,
      stop_desk: input.isStopDesk ? 1 : 0,
    };
    if (phone2) body.phone_2 = phone2;
    if (input.isStopDesk) body.station_code = String(input.stopDeskId).trim();
    if (input.weight !== undefined) body.poids = input.weight;
    if (input.remark?.trim()) body.remarque = input.remark.trim();
    if (input.orderId?.trim()) body.reference = input.orderId.trim();

    const res = await this.http.request<unknown>({ method: 'POST', path: '/create/order', body });
    const resBody = res.body;
    if (isRecord(resBody) && resBody.success === false) throw businessError(resBody, res.status, 'NOEST rejected the order');
    const tracking = isRecord(resBody) && hasValue(resBody.tracking) ? String(resBody.tracking).trim() : undefined;
    if (!tracking) {
      throw new ShippingError('PROVIDER_ERROR', 'NOEST did not return a tracking number', { provider: PROVIDER, raw: resBody });
    }
    let status: ParcelStatus = 'pending';
    if (this.autoValidate) {
      await this.validateOrder(tracking);
      status = 'created';
    }
    return withRaw({ id: tracking, trackingNumber: tracking, status, provider: PROVIDER }, resBody, this.includeRaw);
  }

  /**
   * `POST /get/trackings/info` for one tracking number. Status comes from each
   * `activity[].event_key` (or the English `event` label); remark events keep the previous
   * status. No activity yet means the order is not validated (`pending`).
   */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const notFound = (raw: unknown, httpStatus?: number) =>
      new ShippingError('NOT_FOUND', `Unknown NOEST tracking number: ${tracking}`, { provider: PROVIDER, raw, httpStatus });
    let body: unknown;
    try {
      body = (
        await this.http.request<unknown>({
          method: 'POST',
          path: '/get/trackings/info',
          body: { user_guid: this.userGuid, trackings: [tracking] },
        })
      ).body;
    } catch (err) {
      // Unknown trackings: HTTP 404 `{ message: "Trackings non trouvés" }`.
      if (err instanceof ShippingError && err.httpStatus === 404) throw notFound(err.raw, 404);
      throw err;
    }
    const info = isRecord(body) ? body[tracking] : undefined;
    if (!isRecord(info)) throw notFound(body);

    const rows = entries(info.activity)
      .filter(isRecord)
      .map((a, i) => ({ a, i, at: toIsoDate(str(a.date) ?? '', ALGERIA_OFFSET) }))
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i));

    let current: ParcelStatus = 'pending';
    const events: TrackingEvent[] = rows.map(({ a, at }) => {
      const key = str(a.event_key) ?? '';
      const label = str(a.event) ?? key;
      if (!REMARK_EVENTS.has(normalizeStatusKey(key))) {
        current = key ? mapNoestStatus(key) : mapNoestStatus(label);
      }
      return withRaw({ status: current, label, at }, a, this.includeRaw);
    });

    return {
      parcel: withRaw({ id: tracking, trackingNumber: tracking, status: current, provider: PROVIDER }, info, this.includeRaw),
      events,
    };
  }

  /**
   * `GET /fees`: the partner's grid, `tarifs.delivery` (home `tarif`, `tarif_stopdesk`) and
   * `tarifs.return`, keyed by wilaya. Wilayas without a row are not served.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }
    const code = Number(await this.resolveWilayaCode(query.toWilayaId));

    const res = await this.http.request<unknown>({ method: 'GET', path: '/fees' });
    const body = res.body;
    const tarifs = isRecord(body) && isRecord(body.tarifs) ? body.tarifs : undefined;
    if (!tarifs || tarifs.delivery === undefined) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected NOEST fees response', { provider: PROVIDER, raw: body });
    }
    const rowOf = (list: unknown) =>
      entries(list).find((r): r is Record<string, unknown> => isRecord(r) && Number(r.wilaya_id) === code);
    const positive = (v: unknown) => {
      const n = num(v);
      return n !== undefined && n > 0 ? n : undefined;
    };

    const delivery = rowOf(tarifs.delivery);
    const home = positive(delivery?.tarif);
    const desk = positive(delivery?.tarif_stopdesk);
    const deliveryFee = query.isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', `No NOEST ${query.isStopDesk ? 'stop-desk' : 'home'} rate for wilaya ${code}`, {
        provider: PROVIDER,
        raw: body,
      });
    }

    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    const returns = rowOf(tarifs.return);
    const returnFee = num(query.isStopDesk ? returns?.tarif_stopdesk : returns?.tarif);
    if (returnFee !== undefined) quote.returnFee = returnFee;
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, body, this.includeRaw);
  }

  /** `GET /get/wilayas`: active wilayas only (`is_active: 1`). */
  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.http
      .request<unknown>({ method: 'GET', path: '/get/wilayas' })
      .then(({ body }) => {
        if (!Array.isArray(body) && !isRecord(body)) {
          throw new ShippingError('PROVIDER_ERROR', 'Unexpected NOEST wilayas response', { provider: PROVIDER, raw: body });
        }
        return entries(body).flatMap((w) => {
          if (!isRecord(w) || !hasValue(w.code) || !isActive(w)) return [];
          const id = String(Number(w.code));
          return [withRaw({ id, name: String(w.nom ?? '').trim(), code: id }, w, this.includeRaw)];
        });
      })
      .catch((err) => {
        this.wilayasCache = undefined;
        throw err;
      });
    return this.wilayasCache;
  }

  /** `GET /get/communes/{wilaya_id}`: active communes, `id` = `code` = postal code. */
  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    return this.communesOf(await this.resolveWilayaCode(wilayaId));
  }

  /**
   * `GET /desks` (all NOEST stations, keyed `"16B"`), filtered by wilaya. The desk `id` is
   * the station `code`, sent back as `station_code` by `createParcel`. With `communeId`, only
   * desks whose `commune` is that commune are kept (same spelling as `get/communes`).
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    const code = await this.resolveWilayaCode(query.wilayaId);
    let desks = (await this.desks()).filter(({ desk }) => desk.wilayaId === code);
    if (hasValue(query.communeId)) {
      const commune = normalizeStatusKey((await this.resolveCommune(code, query.communeId!)).name);
      desks = desks.filter((d) => d.commune === commune);
    }
    return desks.map(({ desk }) => desk);
  }

  async listParcels(): Promise<never> {
    throw new ShippingError('NOT_SUPPORTED', 'NOEST has no endpoint to list parcels', { provider: PROVIDER });
  }

  /**
   * `POST /delete/order`. NOEST only deletes orders that are not validated yet; otherwise
   * it answers `{ success: false }` and this throws `VALIDATION_ERROR`.
   */
  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const tracking = trackingNumberOrId?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });

    const res: HttpResponse<unknown> = await this.http.request<unknown>({
      method: 'POST',
      path: '/delete/order',
      body: { user_guid: this.userGuid, tracking },
    });
    if (isRecord(res.body) && res.body.success === false) {
      throw new ShippingError(
        'VALIDATION_ERROR',
        str(res.body.message) ||
          `NOEST order ${tracking} cannot be cancelled: it does not exist or has already been validated (only orders not yet validated can be deleted)`,
        { httpStatus: res.status, raw: res.body, provider: PROVIDER },
      );
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

  /** `POST /valid/order` — hands the order over to NOEST logistics. */
  private async validateOrder(tracking: string): Promise<void> {
    try {
      const res = await this.http.request<unknown>({
        method: 'POST',
        path: '/valid/order',
        body: { user_guid: this.userGuid, tracking },
      });
      if (isRecord(res.body) && res.body.success === false) {
        throw businessError(res.body, res.status, 'NOEST refused to validate the order');
      }
    } catch (err) {
      if (!(err instanceof ShippingError)) throw err;
      throw new ShippingError(
        err.code,
        `NOEST order ${tracking} was created but could not be validated: ${err.message}`,
        { httpStatus: err.httpStatus, details: err.details, raw: err.raw, provider: PROVIDER, retryAfter: err.retryAfter },
      );
    }
  }

  /** Every station, with its normalized `commune` for the `communeId` filter. */
  private desks(): Promise<Array<{ desk: StopDesk; commune: string }>> {
    this.desksCache ??= this.http
      .request<unknown>({ method: 'GET', path: '/desks' })
      .then(({ body }) => {
        if (!Array.isArray(body) && !isRecord(body)) {
          throw new ShippingError('PROVIDER_ERROR', 'Unexpected NOEST desks response', { provider: PROVIDER, raw: body });
        }
        return entries(body).flatMap((d) => {
          if (!isRecord(d) || !hasValue(d.code)) return [];
          const id = String(d.code).trim();
          const wilaya = /^(\d{1,2})/.exec(id);
          if (!wilaya) return [];
          const desk: StopDesk = { id, name: String(d.name ?? id).trim(), wilayaId: String(Number(wilaya[1])) };
          if (hasValue(d.address)) desk.address = String(d.address).trim();
          const phone = entries(d.phones).map(str).find(Boolean);
          if (phone) desk.phone = phone;
          if (hasValue(d.horaires)) desk.openingHours = String(d.horaires).trim();
          return [{ desk: withRaw(desk, d, this.includeRaw), commune: normalizeStatusKey(String(d.commune ?? '')) }];
        });
      })
      .catch((err) => {
        this.desksCache = undefined;
        throw err;
      });
    return this.desksCache;
  }

  private communesOf(wilayaCode: string): Promise<Location[]> {
    let cached = this.communesCache.get(wilayaCode);
    if (!cached) {
      cached = this.http
        .request<unknown>({ method: 'GET', path: `/get/communes/${wilayaCode}` })
        .then(({ body }) => {
          if (!Array.isArray(body) && !isRecord(body)) {
            throw new ShippingError('PROVIDER_ERROR', 'Unexpected NOEST communes response', { provider: PROVIDER, raw: body });
          }
          return entries(body).flatMap((c) => {
            if (!isRecord(c) || !hasValue(c.nom) || !isActive(c)) return [];
            if (hasValue(c.wilaya_id) && Number(c.wilaya_id) !== Number(wilayaCode)) return [];
            const name = String(c.nom).trim();
            const location: Location = {
              id: hasValue(c.code_postal) ? String(c.code_postal).trim() : name,
              name,
              parentId: wilayaCode,
            };
            if (hasValue(c.code_postal)) location.code = String(c.code_postal).trim();
            return [withRaw(location, c, this.includeRaw)];
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

  /** Official code `1`–`58` as-is (NOEST ids are the codes); names via `get/wilayas`. */
  private async resolveWilayaCode(ref: string | number): Promise<string> {
    const value = String(ref).trim();
    if (isWilayaCode(value)) return String(Number(value));
    const found = /^\d+$/.test(value) ? undefined : findLocationByName(await this.getWilayas(), value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${value}`, { provider: PROVIDER });
    return found.id;
  }

  private async resolveCommune(wilayaCode: string, ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const communes = await this.communesOf(wilayaCode);
    const found = communes.find((c) => c.id === value) ?? findLocationByName(communes, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilayaCode}`, { provider: PROVIDER });
    }
    return found;
  }
}
