/**
 * Elogistia provider — `api.elogistia.com`.
 *
 * Elogistia publishes no API documentation. This provider follows the endpoints used in
 * production by the legacy Confirmation-api and was checked against live responses
 * (2026-10-30; mapping in docs/PROVIDERS.md#elogistia):
 *
 * - The API key travels in the query string (`key=` on reference data, `apiKey=` on orders).
 * - Errors: `{ "Message": "..." }` (401 bad key, 404 unknown parcel), `{ "error": "..." }`
 *   (400 missing parameter) or a bare JSON string (`"fee not found.0"`, bad key on fees).
 * - No stop-desk list, parcel list or cancellation endpoint: those throw `NOT_SUPPORTED`.
 */
import { ShippingError } from '../errors';
import { HttpClient, type ErrorBodyParser } from '../http';
import { createStatusMapper } from '../status';
import type {
  ElogistiaConfig,
  FeeQuery,
  FeeQuote,
  HealthCheckResult,
  Location,
  Parcel,
  ParcelInput,
  ParcelListPage,
  ParcelStatus,
  StopDesk,
  TrackingEvent,
  TrackResult,
} from '../types';
import {
  compareDates,
  findLocationByName,
  findLocationLoosely,
  isRecord,
  isWilayaCode,
  normalizeAlgerianPhone,
  productDescription,
  requireHttps,
  str,
  toIsoDate,
  validateParcelInput,
  withRaw,
} from '../utils';
import { probeWilayasHealth } from './health';
import type { ShippingProvider } from './types';

const PROVIDER = 'elogistia';
export const ELOGISTIA_DEFAULT_BASE_URL = 'https://api.elogistia.com';
const ALGERIA_OFFSET = '+01:00';
/** `mail` is mandatory on `insertCommande`; parcels carry no e-mail in the unified input. */
const DEFAULT_EMAIL = 'customer@example.com';
const DELIVERY_HOME = 1;
const DELIVERY_STOP_DESK = 2;
const MODE_STANDARD = 1;

/**
 * Elogistia publishes no status list: labels (`Statut`, else `Log`) are matched by keyword,
 * in this order. MUST stay identical to the PHP `StatusMapper::elogistia`
 * (enforced by docs/fixtures/elogistia/statuses.json).
 */
const mapElogistiaKey = createStatusMapper({
  exact: {},
  keywords: [
    // Returns and cancellations first ("Retourné à l'expéditeur", "Annulé en livraison").
    ['retour', 'returned'],
    ['return', 'returned'],
    ['annul', 'cancelled'],
    ['cancel', 'cancelled'],
    ['supprim', 'cancelled'],
    // "Livreur" / "en livraison" contain "livr": decide transit before "livré".
    ['livreur', 'in_transit'],
    ['enlivraison', 'in_transit'],
    ['sortie', 'in_transit'],
    ['transit', 'in_transit'],
    ['expedi', 'in_transit'],
    ['dispatch', 'in_transit'],
    ['verswilaya', 'in_transit'],
    ['encours', 'in_transit'],
    ['echec', 'in_transit'],
    ['tentative', 'in_transit'],
    ['livre', 'delivered'],
    ['delivered', 'delivered'],
    ['attente', 'pending'],
    ['cree', 'pending'],
    ['nouveau', 'pending'],
    ['pending', 'pending'],
  ],
});

/** Elogistia status label → unified status (keyword rules, see `mapElogistiaKey`). */
export function mapElogistiaStatus(native: string | null | undefined): ParcelStatus {
  return mapElogistiaKey(native);
}

/** `Missing parameter: commune` → `communeId`. */
const FIELDS: Record<string, string> = {
  name: 'recipientName',
  firstname: 'recipientName',
  phone: 'phone',
  address: 'address',
  commune: 'communeId',
  wilaya: 'wilayaId',
  product: 'productName',
  price: 'price',
  IdCommande: 'orderId',
};

const parseElogistiaError: ErrorBodyParser = (body) => {
  if (typeof body === 'string') return body ? { message: body.slice(0, 500) } : undefined;
  if (!isRecord(body)) return undefined;
  const message = str(body.Message) ?? str(body.error) ?? str(body.message);
  if (!message) return undefined;
  const missing = /^Missing parameter:\s*(\w+)/i.exec(message)?.[1];
  return missing ? { message, details: [{ field: FIELDS[missing] ?? missing, message }] } : { message };
};

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** `body: [...]` of every reference-data answer. */
function bodyList(body: unknown, what: string): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.body)) {
    throw new ShippingError('PROVIDER_ERROR', `Unexpected Elogistia ${what} response`, {
      provider: PROVIDER,
      raw: body,
    });
  }
  return body.body.filter(isRecord);
}

export class ElogistiaProvider implements ShippingProvider {
  readonly name = PROVIDER;
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly email: string;
  private readonly includeRaw: boolean;
  private feesCache?: Promise<Record<string, unknown>[]>;
  private communesCache?: Promise<Record<string, unknown>[]>;

  constructor(config: ElogistiaConfig) {
    const apiKey = config?.apiKey?.trim();
    if (!apiKey)
      throw new ShippingError('AUTH_FAILED', 'Elogistia requires `apiKey`', {
        provider: PROVIDER,
      });
    this.apiKey = apiKey;
    this.email = config.email?.trim() || DEFAULT_EMAIL;
    this.includeRaw = config.includeRaw ?? true;
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: requireHttps(config.baseUrl?.trim() || ELOGISTIA_DEFAULT_BASE_URL, PROVIDER),
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
      parseError: parseElogistiaError,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * `POST /insertCommande/` with every field in the query string. The commune is sent with
   * Elogistia's spelling (resolved through `getMunicipalities`). Stop desk: `stop_desk=2`;
   * Elogistia picks the desk itself, so `stopDeskId` is not sent. Answer `{ success: "<tracking>" }`.
   */
  async createParcel(input: ParcelInput): Promise<Parcel> {
    validateParcelInput(input, PROVIDER);
    const phone = normalizeAlgerianPhone(input.phone, 'local', PROVIDER, 'phone');
    const wilayaCode = await this.resolveWilayaCode(input.wilayaId ?? input.wilayaName!);
    const commune = await this.resolveCommune(wilayaCode, input.communeId ?? input.communeName!);

    // `name` (family name) and `firstname` are both required: a one-word name fills both.
    const [first, ...rest] = input.recipientName.trim().split(/\s+/);
    const query: Record<string, string | number> = {
      apiKey: this.apiKey,
      name: rest.length > 0 ? rest.join(' ') : first!,
      firstname: first!,
      mail: this.email,
      phone,
      address: input.address.trim() || commune.name,
      commune: commune.name,
      wilaya: Number(wilayaCode),
      product: productDescription(input),
      // `price` is what the recipient pays; the delivery fee is already in it.
      price: Math.round(input.price),
      fraisDeLivraison: 0,
      stop_desk: input.isStopDesk ? DELIVERY_STOP_DESK : DELIVERY_HOME,
      modeDeLivraison: MODE_STANDARD,
      IdCommande: input.orderId?.trim() || `dzd-${Date.now()}`,
    };
    if (input.remark?.trim()) query.remarque = input.remark.trim();

    const res = await this.http.request<unknown>({
      method: 'POST',
      path: '/insertCommande/',
      query,
    });
    const body = res.body;
    if (isRecord(body) && hasValue(body.error)) {
      throw new ShippingError('VALIDATION_ERROR', String(body.error), {
        httpStatus: res.status,
        raw: body,
        provider: PROVIDER,
      });
    }
    const tracking = isRecord(body) ? str(body.success) : undefined;
    if (!tracking) {
      throw new ShippingError('PROVIDER_ERROR', 'Elogistia did not return a tracking number', {
        provider: PROVIDER,
        raw: body,
      });
    }
    return withRaw(
      {
        id: tracking,
        trackingNumber: tracking,
        status: 'pending',
        provider: PROVIDER,
      },
      body,
      this.includeRaw,
    );
  }

  /**
   * `GET /getTracking/?tracking=`: `body: [{ Date, Statut, Log }]`. HTTP 404
   * `"Commande not found or no log yet."` → `NOT_FOUND` (also for a parcel with no log yet).
   */
  async track(trackingNumber: string): Promise<TrackResult> {
    const tracking = trackingNumber?.trim();
    if (!tracking) throw new ShippingError('VALIDATION_ERROR', 'trackingNumber is required', { provider: PROVIDER });

    const { body } = await this.http.request<unknown>({
      method: 'GET',
      path: '/getTracking/',
      query: { apiKey: this.apiKey, tracking },
    });
    const events: TrackingEvent[] = bodyList(body, 'tracking')
      .map((step, i) => ({
        step,
        i,
        at: toIsoDate(str(step.Date) ?? '', ALGERIA_OFFSET),
      }))
      .sort((x, y) => compareDates(x.at, y.at) || x.i - y.i)
      .map(({ step, at }) => {
        const statut = str(step.Statut) || undefined;
        const log = str(step.Log) || undefined;
        const label = statut && log && log !== statut ? `${statut} (${log})` : (statut ?? log ?? '');
        return withRaw({ status: mapElogistiaStatus(statut ?? log), label, at }, step, this.includeRaw);
      });
    const known = [...events].reverse().find((e) => e.status !== 'unknown');
    return {
      parcel: withRaw(
        {
          id: tracking,
          trackingNumber: tracking,
          status: known?.status ?? 'unknown',
          provider: PROVIDER,
        },
        body,
        this.includeRaw,
      ),
      events,
    };
  }

  /** `GET /getShippingCost/`: per-wilaya `home` and `stopdesk` rates. No return fee. */
  async getFees(query: FeeQuery): Promise<FeeQuote> {
    if (!hasValue(query?.toWilayaId)) {
      throw new ShippingError('VALIDATION_ERROR', 'toWilayaId is required', {
        provider: PROVIDER,
      });
    }
    const code = await this.resolveWilayaCode(query.toWilayaId);
    const rows = await this.feeRows();
    const row = rows.find((r) => Number(r.wilayaID) === Number(code));
    const home = num(row?.home);
    const desk = num(row?.stopdesk);
    const deliveryFee = query.isStopDesk ? desk : home;
    if (deliveryFee === undefined) {
      throw new ShippingError(
        'NOT_FOUND',
        `No Elogistia ${query.isStopDesk ? 'stop-desk' : 'home'} rate for wilaya ${code}`,
        {
          provider: PROVIDER,
        },
      );
    }
    const quote: FeeQuote = { deliveryFee, currency: 'DZD' };
    if (desk !== undefined) quote.stopDeskFee = desk;
    return withRaw(quote, row, this.includeRaw);
  }

  /** Wilayas of the fee grid (`getShippingCost`), ordered by code: the ones Elogistia serves. */
  async getWilayas(): Promise<Location[]> {
    return (await this.feeRows())
      .filter((r) => hasValue(r.wilayaID))
      .map((r) => {
        const id = String(Number(r.wilayaID));
        return withRaw({ id, name: String(r.wilayaLabel ?? '').trim(), code: id }, r, this.includeRaw);
      })
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** `GET /getMunicipalities/` (every commune, filtered by wilaya). `Location.id` = Elogistia `Id`. */
  async getCommunes(wilayaId: string | number): Promise<Location[]> {
    const code = await this.resolveWilayaCode(wilayaId);
    return (await this.communeRows())
      .filter((c) => Number(c.wilaya) === Number(code) && hasValue(c.Id) && hasValue(c.name))
      .map((c) => withRaw({ id: String(c.Id), name: String(c.name).trim(), parentId: code }, c, this.includeRaw));
  }

  /** Elogistia has no stop-desk list: with `isStopDesk`, it picks the desk itself. */
  async getStopDesks(): Promise<StopDesk[]> {
    throw new ShippingError('NOT_SUPPORTED', 'Elogistia has no stop-desk list (it assigns the desk itself)', {
      provider: PROVIDER,
    });
  }

  async listParcels(): Promise<ParcelListPage> {
    throw new ShippingError('NOT_SUPPORTED', 'Elogistia has no parcel listing endpoint', { provider: PROVIDER });
  }

  async cancelParcel(): Promise<void> {
    throw new ShippingError('NOT_SUPPORTED', 'Elogistia has no cancellation endpoint (cancel from the dashboard)', {
      provider: PROVIDER,
    });
  }

  /** Probes `getShippingCost` (bypasses cache). */
  healthCheck(): Promise<HealthCheckResult> {
    return probeWilayasHealth(
      PROVIDER,
      () => {
        this.feesCache = undefined;
      },
      () => this.getWilayas(),
    );
  }

  // --- internals -------------------------------------------------------------

  /** A wrong key answers HTTP 404 `"fee not found.0"` here: reported as `AUTH_FAILED`. */
  private feeRows(): Promise<Record<string, unknown>[]> {
    this.feesCache ??= this.http
      .request<unknown>({
        method: 'GET',
        path: '/getShippingCost/',
        query: { key: this.apiKey },
      })
      .then(({ body }) => bodyList(body, 'fees'))
      .catch((err) => {
        this.feesCache = undefined;
        if (err instanceof ShippingError && err.httpStatus === 404) {
          throw new ShippingError('AUTH_FAILED', `Elogistia returned no fee grid (check apiKey): ${err.message}`, {
            httpStatus: 404,
            raw: err.raw,
            provider: PROVIDER,
          });
        }
        throw err;
      });
    return this.feesCache;
  }

  private communeRows(): Promise<Record<string, unknown>[]> {
    this.communesCache ??= this.http
      .request<unknown>({
        method: 'GET',
        path: '/getMunicipalities/',
        query: { key: this.apiKey },
      })
      .then(({ body }) => bodyList(body, 'communes'))
      .catch((err) => {
        this.communesCache = undefined;
        throw err;
      });
    return this.communesCache;
  }

  /** Official code `1`–`58` as-is; names through the fee grid. */
  private async resolveWilayaCode(ref: string | number): Promise<string> {
    const value = String(ref).trim();
    if (isWilayaCode(value)) return String(Number(value));
    const found = /^\d+$/.test(value) ? undefined : findLocationByName(await this.getWilayas(), value);
    if (!found)
      throw new ShippingError('NOT_FOUND', `Unknown wilaya: ${value}`, {
        provider: PROVIDER,
      });
    return found.id;
  }

  /** By Elogistia id, exact name, then spelling-tolerant name (unambiguous only). */
  private async resolveCommune(wilayaCode: string, ref: string | number): Promise<Location> {
    const value = String(ref).trim();
    const communes = await this.getCommunes(wilayaCode);
    const found =
      communes.find((c) => c.id === value) ??
      findLocationByName(communes, value) ??
      findLocationLoosely(communes, value);
    if (!found) {
      throw new ShippingError('NOT_FOUND', `Unknown commune: ${value} in wilaya ${wilayaCode}`, { provider: PROVIDER });
    }
    return found;
  }
}
