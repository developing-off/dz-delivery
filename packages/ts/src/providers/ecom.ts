/**
 * E-com Delivery provider — `ecom-dz.com/api_v2`.
 *
 * Built from the E-com Delivery API v2 documentation (developer page, v2.153, 2026-10-30;
 * mapping in docs/PROVIDERS.md#ecom):
 *
 * - Auth headers `X-API-Key` + `X-API-Token`.
 * - Global errors share one shape: `{ error: { code, message, details? } }` (401, 404, 409,
 *   422, 429). Creation is best-effort per line: HTTP 201 with `resultats[i].ok === false`.
 * - Parcels stay "En Préparation" (editable, deletable) until confirmed: see `autoValidate`.
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper, normalizeStatusKey } from '../status';
import {
  PARCEL_STATUSES,
  type EcomConfig,
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
  type StopDesk,
  type StopDeskQuery,
  type TrackingEvent,
  type TrackResult,
} from '../types';
import {
  findLocationByName,
  findLocationLoosely,
  isRecord,
  isWilayaCode,
  looseNameKey,
  normalizeAlgerianPhone,
  productDescription,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

const PROVIDER = 'ecom';
export const ECOM_DEFAULT_BASE_URL = 'https://ecom-dz.com/api_v2';
const ALGERIA_OFFSET = '+01:00';
const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const mapEcomKey = createStatusMapper({
  exact: {
    // États logistiques (`etat_logistique`, history steps).
    'En Préparation': 'pending',
    'En Traitement': 'created',
    'Au Bureau': 'in_transit',
    'En livraison': 'in_transit',
    'Sortir en livraison': 'in_transit',
    Dispatcher: 'in_transit',
    // Seen live, not in the docs: payment collected after delivery, parcel back at the seller.
    Récupérer: 'delivered',
    'Retour Fournisseur': 'returned',
    'Retour Stock': 'returned',
    // Situations (`situation`, GET /situations).
    'Attend Confirmation': 'pending',
    'Commande Reporté': 'pending',
    'Commande a Relancé': 'pending',
    'Commande Confirmée': 'created',
    'Ne Réponde pas #1': 'in_transit',
    'Ne Réponde pas #2': 'in_transit',
    'Ne Réponde pas #3': 'in_transit',
    'En attente du client': 'in_transit',
    Reporté: 'in_transit',
    'Reporté Commune Erronée': 'in_transit',
    'Reporté Wilaya Erronée': 'in_transit',
    'Appel Tel': 'in_transit',
    'SMS Envoyé': 'in_transit',
    'WhatsApp OK': 'in_transit',
    Livrée: 'delivered',
    Encaisser: 'delivered',
    Recouvert: 'delivered',
    Annuler: 'returned',
    'Annuler x3': 'returned',
    'Retour de Dispatche': 'returned',
    'Retour Navette': 'returned',
    'Commande Annuler': 'cancelled',
    Supprimée: 'cancelled',
  },
});

/**
 * E-com situation (`Livrée`, `Ne Réponde pas #1`, ...) or état logistique (`En Préparation`,
 * `Au Bureau`, ...) label → unified status. `EnCours` (the default situation), `BIZ` and
 * `Suivi par E-com` say nothing about the parcel and map to `unknown`, as do the history-only
 * notes (`Information`, `Type de Colis`, `Type de Livraison`).
 * MUST stay identical to the PHP `StatusMapper::ecom` (enforced by docs/fixtures/ecom/statuses.json).
 */
export function mapEcomStatus(native: string | null | undefined): ParcelStatus {
  return mapEcomKey(native);
}

const FINAL: readonly ParcelStatus[] = ['delivered', 'returned', 'cancelled'];

/**
 * A parcel's status from its two labels: a final situation (delivered, returned, cancelled)
 * wins, then the physical état logistique, then any other situation.
 */
function parcelStatus(situation: unknown, etat: unknown): ParcelStatus {
  const fromSituation = mapEcomStatus(str(situation));
  if (FINAL.includes(fromSituation)) return fromSituation;
  const fromEtat = mapEcomStatus(str(etat));
  return fromEtat !== 'unknown' ? fromEtat : fromSituation;
}

/** E-com field (validation `champ`, per-line `code`) → ParcelInput field. */
const FIELDS: Record<string, string> = {
  nom_complet: 'recipientName',
  mobile_1: 'phone',
  mobile_2: 'phone2',
  adresse: 'address',
  id_wilaya: 'wilayaId',
  commune: 'communeId',
  code_stopdesk: 'stopDeskId',
  article: 'productName',
  ref_article: 'productList',
  quantite: 'productList',
  total: 'price',
  note_fournisseur: 'remark',
  id_externe: 'orderId',
};

/** Per-line creation error code → ParcelInput field (codes per the docs; unknown codes keep no field). */
const LINE_CODE_FIELDS: Record<string, string> = {
  total_insuffisant: 'price',
};

/** Field of a rejected creation line: by `code`, else `stopdesk introuvable (...)` (code `validation`, seen live). */
function lineField(code: string | undefined, message: string): string | undefined {
  if (code && LINE_CODE_FIELDS[code]) return LINE_CODE_FIELDS[code];
  return /stop\s*desk/i.test(message) ? 'stopDeskId' : undefined;
}

/** `0.nom_complet` → `recipientName`. */
function fieldOf(champ: string): string {
  const name = champ.replace(/^(body\.)?\d+\./, '');
  return FIELDS[name] ?? name;
}

/** `{ error: {...} }`, or `{ detail: { error: {...} } }` (opening-hours refusals). */
function errorObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error)) return body.error;
  if (isRecord(body.detail) && isRecord(body.detail.error)) return body.detail.error;
  return undefined;
}

const parseEcomError: ErrorBodyParser = (body) => {
  const error = errorObject(body);
  if (!error) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : undefined;
  const code = str(error.code);
  const message = str(error.message);
  const details: ShippingErrorDetail[] = [];
  if (Array.isArray(error.details)) {
    for (const d of error.details) {
      if (isRecord(d) && str(d.raison)) details.push({ field: fieldOf(str(d.champ) ?? ''), message: str(d.raison)! });
    }
  } else if (code) {
    const detail: ShippingErrorDetail = { message: message ?? code, code };
    if (LINE_CODE_FIELDS[code]) detail.field = LINE_CODE_FIELDS[code];
    details.push(detail);
  }
  return { message: message ?? code, details };
};

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** Date part (`YYYY-MM-DD`) of an ISO instant, in Algeria time. */
function algeriaDate(iso: string): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t + 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface CommuneRow {
  location: Location;
  deliverable: boolean;
}

export class EcomProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly includeRaw: boolean;
  private readonly autoValidate: boolean;
  private wilayasCache?: Promise<Location[]>;
  private readonly communesCache = new Map<string, Promise<CommuneRow[]>>();

  constructor(config: EcomConfig) {
    const apiKey = config?.apiKey?.trim();
    const apiToken = config?.apiToken?.trim();
    if (!apiKey || !apiToken) {
      throw new ShippingError('AUTH_FAILED', 'E-com requires `apiKey` and `apiToken`', { provider: PROVIDER });
    }
    this.includeRaw = config.includeRaw ?? true;
    this.autoValidate = config.autoValidate ?? false;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: config.baseUrl?.trim() || ECOM_DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseEcomError,
      headers: {
        'X-API-Key': apiKey,
        'X-API-Token': apiToken,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * `POST /colis` with a one-item array. Home delivery: the commune is resolved through
   * `GET /communes` (id, postal code, name, then spelling-tolerant name). Stop desk: only
   * `code_stopdesk` is read by E-com. With `autoValidate`, the parcel is created confirmed
   * (`confirmee: 1`, "En Traitement").
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const phone2 = input.phone2 ? normalizeAlgerianPhone(input.phone2, 'local', PROVIDER, 'phone2') : undefined;
    const wilayaCode = await this.resolveWilayaCode(input.wilayaId ?? input.wilayaName!);

    const colis: Record<string, unknown> = {
      nom_complet: input.recipientName.trim(),
      mobile_1: phone,
      id_wilaya: Number(wilayaCode),
      total: Math.round(input.price),
      stopdesk: input.isStopDesk ? 1 : 0,
    };
    if (input.isStopDesk) {
      colis.code_stopdesk = String(input.stopDeskId).trim();
    } else {
      colis.commune = (await this.resolveCommune(wilayaCode, input.communeId ?? input.communeName!, true)).name;
    }
    // One product line → its name and quantity (and `ref_article` from its sku, for stock
    // accounts); several → a description, quantity 1.
    const single = input.productList?.length === 1 ? input.productList[0]! : undefined;
    colis.article = single ? single.name.trim() : productDescription(input);
    colis.quantite = single ? single.quantity : 1;
    if (single?.sku?.trim()) colis.ref_article = single.sku.trim();
    if (phone2) colis.mobile_2 = phone2;
    if (input.address.trim()) colis.adresse = input.address.trim();
    if (input.remark?.trim()) colis.note_fournisseur = input.remark.trim();
    if (input.orderId?.trim()) colis.id_externe = input.orderId.trim();
    if (this.autoValidate) colis.confirmee = 1;

    const res = await this.http.request<unknown>({ method: 'POST', path: '/colis', body: [colis] });
    const line = isRecord(res.body) && Array.isArray(res.body.resultats) ? res.body.resultats.find(isRecord) : undefined;
    if (!line) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com creation response', { provider: PROVIDER, raw: res.body });
    }
    if (line.ok !== true) {
      const code = str(line.code);
      const message = str(line.erreur) ?? 'E-com rejected the parcel';
      const detail: ShippingErrorDetail = { message };
      if (code) detail.code = code;
      const field = lineField(code, message);
      if (field) detail.field = field;
      throw new ShippingError('VALIDATION_ERROR', message, { httpStatus: res.status, details: [detail], raw: res.body, provider: PROVIDER });
    }
    const tracking = str(line.tracking);
    if (!tracking) {
      throw new ShippingError('PROVIDER_ERROR', 'E-com did not return a tracking number', { provider: PROVIDER, raw: res.body });
    }
    const status: ParcelStatus = this.autoValidate ? 'created' : 'pending';
    return withRaw({ id: tracking, trackingNumber: tracking, status, provider: PROVIDER }, res.body, this.includeRaw);
  }

  /**
   * `GET /colis/{tracking}`: current `situation` + `etat_logistique`, and the `historique`
   * steps (oldest first). Unknown tracking → HTTP 404 `colis_introuvable` → `NOT_FOUND`.
   */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const { body } = await this.http.request<unknown>({ method: 'GET', path: `/colis/${encodeURIComponent(tracking)}` });
    if (!isRecord(body)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com parcel response', { provider: PROVIDER, raw: body });
    }
    // Notes (`Information`, `Type de Livraison`, `BIZ`, no situation, ...) keep the previous status.
    let current: ParcelStatus = 'pending';
    const events: TrackingEvent[] = (Array.isArray(body.historique) ? body.historique : [])
      .filter(isRecord)
      .map((step, i) => ({ step, i, at: toIsoDate(str(step.date) ?? '', ALGERIA_OFFSET) }))
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i))
      .map(({ step, at }) => {
        const situation = str(step.situation) ?? '';
        const comment = str(step.commentaire);
        const label = situation && comment ? `${situation} (${comment})` : situation || comment || '';
        const status = mapEcomStatus(situation);
        if (status !== 'unknown') current = status;
        return withRaw({ status: current, label, at }, step, this.includeRaw);
      });

    return { parcel: this.toParcel(body, tracking), events };
  }

  /**
   * `GET /tarifs`: per-wilaya `domicile` / `stopdesk` rates and the `annuler` (cancellation)
   * fee. The account-wide `service` and `emballage` fees are billed on top and only in `raw`.
   */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', { provider: PROVIDER });
    }
    const code = Number(await this.resolveWilayaCode(query.toWilayaId));

    const { body } = await this.http.request<unknown>({ method: 'GET', path: '/tarifs' });
    if (!isRecord(body) || !Array.isArray(body.wilayas)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com fees response', { provider: PROVIDER, raw: body });
    }
    const row = body.wilayas.find((r): r is Record<string, unknown> => isRecord(r) && Number(r.wilaya) === code);
    const home = num(row?.domicile);
    const desk = num(row?.stopdesk);
    const deliveryFee = query.isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError('NOT_FOUND', `No E-com ${query.isStopDesk ? 'stop-desk' : 'home'} rate for wilaya ${code}`, {
        provider: PROVIDER,
        raw: body,
      });
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    const returnFee = num(row?.annuler);
    if (returnFee !== undefined) quote.returnFee = returnFee;
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, body, this.includeRaw);
  }

  /** `GET /wilayas`: wilayas served at home or in a stop desk. */
  getWilayas(): Promise<Location[]> {
    this.wilayasCache ??= this.http
      .request<unknown>({ method: 'GET', path: '/wilayas' })
      .then(({ body }) => {
        if (!Array.isArray(body)) {
          throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com wilayas response', { provider: PROVIDER, raw: body });
        }
        return body.flatMap((w) => {
          if (!isRecord(w) || !hasValue(w.id) || (w.domicile === false && w.stopdesk === false)) return [];
          const id = String(Number(w.id));
          return [withRaw({ id, name: String(w.libelle ?? '').trim(), code: id }, w, this.includeRaw)];
        });
      })
      .catch((err) => {
        this.wilayasCache = undefined;
        throw err;
      });
    return this.wilayasCache;
  }

  /** `GET /communes?id_wilaya=`: deliverable communes only (`livrable: true`). */
  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    const code = await this.resolveWilayaCode(wilayaId);
    return (await this.communesOf(code)).filter((c) => c.deliverable).map((c) => c.location);
  }

  /**
   * `GET /stopdesks?id_wilaya=`. The desk `id` is `code_stopdesk` (→ `ParcelInput.stopDeskId`).
   * With `communeId`, only desks whose `commune` is that commune are kept.
   */
  async getStopDesks(query: StopDeskQuery): Promise<StopDesk[]> {
    if (!hasValue(query?.wilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'wilayaId is required', { provider: PROVIDER });
    }
    const code = await this.resolveWilayaCode(query.wilayaId);
    const { body } = await this.http.request<unknown>({ method: 'GET', path: '/stopdesks', query: { id_wilaya: code } });
    if (!Array.isArray(body)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com stop desks response', { provider: PROVIDER, raw: body });
    }
    let rows = body.filter((d): d is Record<string, unknown> => isRecord(d) && hasValue(d.code_stopdesk));
    if (hasValue(query.communeId)) {
      const commune = (await this.resolveCommune(code, query.communeId!, false)).name;
      rows = rows.filter((d) => {
        const name = String(d.commune ?? '');
        return normalizeStatusKey(name) === normalizeStatusKey(commune) || looseNameKey(name) === looseNameKey(commune);
      });
    }
    return rows.map((d) => {
      const desk: StopDesk = { id: String(d.code_stopdesk).trim(), name: String(d.nom_bureau ?? d.code_stopdesk).trim(), wilayaId: code };
      if (hasValue(d.adresse)) desk.address = String(d.adresse).trim();
      const phone = String(d.tel_contact ?? '').split(/[,;/]/).map((p) => p.trim()).find(Boolean);
      if (phone) desk.phone = phone;
      return withRaw(desk, d, this.includeRaw);
    });
  }

  /**
   * `GET /colis` (newest first, ≤ 100 per page). `keyword` filters by tracking number(s),
   * `updatedSince` uses `type_date=action` from that day (Algeria time): the last logistic move,
   * so parcels not handled yet (no action) are left out. `orderId` and
   * `status` filter the fetched page client-side. E-com only reports `total` on page 1:
   * further pages report a lower bound.
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
    const keep = (parcels: Parcel[]) => (query.status ? parcels.filter((p) => p.status === query.status) : parcels);

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
      return withRaw({ parcels: keep(all), page: 1, pageSize, totalCount, hasNext: false }, lastRaw, this.includeRaw);
    }

    const result = await this.listPage(query, page, pageSize);
    return withRaw(
      { parcels: keep(result.parcels), page, pageSize, totalCount: result.totalCount, hasNext: result.hasNext },
      result.raw,
      this.includeRaw,
    );
  }

  /**
   * `DELETE /colis/{tracking}` (soft delete). Only parcels still "En Préparation":
   * HTTP 409 → `VALIDATION_ERROR`; unknown tracking (404) → `NOT_FOUND`.
   */
  async cancelParcel(trackingNumberOrId: string): Promise<void> {
    const tracking = trackingNumberOrId?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumberOrId is required', { provider: PROVIDER });

    let body: unknown;
    try {
      body = (await this.http.request<unknown>({ method: 'DELETE', path: `/colis/${encodeURIComponent(tracking)}` })).body;
    } catch (err) {
      if (err instanceof ShippingError && err.httpStatus === 409) {
        throw new ShippingError(
          'VALIDATION_ERROR',
          `E-com parcel ${tracking} cannot be cancelled: it has already left preparation (only parcels "En Préparation" can be deleted)`,
          { httpStatus: 409, details: err.details, raw: err.raw, provider: PROVIDER },
        );
      }
      throw err;
    }
    if (isRecord(body) && body.ok === false) {
      throw new ShippingError('VALIDATION_ERROR', str(body.erreur) ?? `E-com refused to delete parcel ${tracking}`, {
        raw: body,
        provider: PROVIDER,
      });
    }
  }

  /** Probes `GET /wilayas` (bypasses cache). */
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

  private toParcel(row: Record<string, unknown>, fallbackTracking: string): Parcel {
    const tracking = str(row.tracking) ?? fallbackTracking;
    return withRaw(
      { id: tracking, trackingNumber: tracking, status: parcelStatus(row.situation, row.etat_logistique), provider: PROVIDER },
      row,
      this.includeRaw,
    );
  }

  private async listPage(
    query: ParcelListQuery,
    page: number,
    pageSize: number,
  ): Promise<{ parcels: Parcel[]; totalCount: number; hasNext: boolean; raw: unknown }> {
    const params: Record<string, string | number> = { page, limit: pageSize };
    if (query.keyword?.trim()) params.tracking = query.keyword.trim();
    if (query.updatedSince) {
      const day = algeriaDate(query.updatedSince);
      if (!day) {
        throw new ShippingError('VALIDATION_ERROR', 'updatedSince must be an ISO 8601 date', {
          provider: PROVIDER,
          details: [{ field: 'updatedSince', message: 'updatedSince must be an ISO 8601 date' }],
        });
      }
      params.type_date = 'action';
      params.date_debut = day;
    }
    const { body } = await this.http.request<unknown>({ method: 'GET', path: '/colis', query: params });
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com parcel list response', { provider: PROVIDER, raw: body });
    }
    const items = body.items.filter(isRecord);
    const orderId = query.orderId?.trim();
    const parcels = items
      .filter((item) => !orderId || str(item.id_externe) === orderId)
      .map((item) => this.toParcel(item, ''));
    const total = num(body.total);
    const totalPages = num(body.total_pages);
    return {
      parcels,
      totalCount: total ?? (page - 1) * pageSize + items.length,
      hasNext: totalPages !== undefined ? page < totalPages : items.length === pageSize,
      raw: body,
    };
  }

  private communesOf(wilayaCode: string): Promise<CommuneRow[]> {
    let cached = this.communesCache.get(wilayaCode);
    if (!cached) {
      cached = this.http
        .request<unknown>({ method: 'GET', path: '/communes', query: { id_wilaya: wilayaCode } })
        .then(({ body }) => {
          if (!Array.isArray(body)) {
            throw new ShippingError('PROVIDER_ERROR', 'Unexpected E-com communes response', { provider: PROVIDER, raw: body });
          }
          return body.flatMap((c) => {
            if (!isRecord(c) || !hasValue(c.commune) || !hasValue(c.id)) return [];
            if (hasValue(c.id_wilaya) && Number(c.id_wilaya) !== Number(wilayaCode)) return [];
            const location: Location = { id: String(c.id), name: String(c.commune).trim(), parentId: wilayaCode };
            if (hasValue(c.code_postal)) location.code = String(c.code_postal).trim();
            return [{ location: withRaw(location, c, this.includeRaw), deliverable: c.livrable !== false }];
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

  /** Official code `1`–`58` as-is (E-com ids are the codes); names via `/wilayas`. */
  private async resolveWilayaCode(ref: string | number): Promise<string> {
    const value = String(ref).trim();
    if (isWilayaCode(value)) return String(Number(value));
    const found = /^\d+$/.test(value) ? undefined : findLocationByName(await this.getWilayas(), value);
    if (!found) throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${value}`, { provider: PROVIDER });
    return found.id;
  }

  /**
   * By id, postal code, exact name, then spelling-tolerant name (unambiguous only).
   * With `deliverableOnly`, a commune E-com does not serve is a `VALIDATION_ERROR`.
   */
  private async resolveCommune(wilayaCode: string, ref: string | number, deliverableOnly: boolean): Promise<Location> {
    const value = String(ref).trim();
    const rows = await this.communesOf(wilayaCode);
    const locations = rows.map((r) => r.location);
    const found =
      locations.find((c) => c.id === value || c.code === value) ??
      findLocationByName(locations, value) ??
      findLocationLoosely(locations, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilayaCode}`, { provider: PROVIDER });
    }
    if (deliverableOnly && !rows.find((r) => r.location === found)!.deliverable) {
      throw new ShippingError('VALIDATION_ERROR', `E-com does not deliver to ${found.name} (wilaya ${wilayaCode})`, {
        provider: PROVIDER,
        details: [{ field: 'communeId', message: `E-com does not deliver to ${found.name}` }],
      });
    }
    return found;
  }
}
