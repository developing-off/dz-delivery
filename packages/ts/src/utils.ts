import { ShippingError } from './errors';
import { normalizeStatusKey } from './status';
import type { Location, ParcelInput, ShippingErrorDetail, TrackingEvent } from './types';

/** National significant number (8–9 digits, no leading `0` / `+213`), or `undefined` if not Algerian. */
export function algerianNationalNumber(phone: string): string | undefined {
  const digits = phone.trim().replace(/[\s\-.()/]/g, '');
  let national: string;
  if (digits.startsWith('+213')) national = digits.slice(4);
  else if (digits.startsWith('00213')) national = digits.slice(5);
  else if (digits.startsWith('213') && digits.length >= 11) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  national = national.replace(/^0+/, '');
  return /^\d{8,9}$/.test(national) ? national : undefined;
}

/**
 * Normalizes an Algerian phone number: `0550 12 34 56` ↔ `+213550123456`.
 * Throws `VALIDATION_ERROR` when the number is not a valid Algerian number.
 */
export function normalizeAlgerianPhone(
  phone: string,
  format: 'international' | 'local',
  provider?: string,
  field = 'phone',
): string {
  const national = algerianNationalNumber(phone);
  if (!national) {
    throw new ShippingError('VALIDATION_ERROR', `Invalid Algerian phone number: ${phone}`, {
      provider,
      details: [{ field, message: `Invalid Algerian phone number: ${phone}` }],
    });
  }
  return format === 'international' ? `+213${national}` : `0${national}`;
}

/** Case-, accent- and punctuation-insensitive key used for name matching (same as PHP `Text::key`). */
export const normalizeName = normalizeStatusKey;

export function findLocationByName(locations: Location[], name: string): Location | undefined {
  const wanted = normalizeName(name);
  return locations.find((l) => normalizeName(l.name) === wanted);
}

/**
 * Spelling-tolerant key for Algerian place names: `normalizeName`, then vowels dropped and
 * doubled letters collapsed, so transliteration variants meet ("Bab Ezzouar" / "Bab Azzouar"
 * → `bzr`). MUST stay identical to the PHP `Text::looseKey`.
 */
export function looseNameKey(name: string): string {
  return normalizeName(name).replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}

/**
 * The single location whose `looseNameKey` equals the one of `name`. `undefined` when none or
 * several match, or when the key is too short (< 3) to be meaningful: never guesses between
 * two communes. Use only after an exact match failed.
 */
export function findLocationLoosely(locations: Location[], name: string): Location | undefined {
  const wanted = looseNameKey(name);
  if (wanted.length < 3) return undefined;
  const hits = locations.filter((l) => looseNameKey(l.name) === wanted);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Converts a native timestamp to ISO 8601 with an explicit offset and second precision
 * (`2025-11-22T09:00:00.123Z` → `2025-11-22T09:00:00+00:00`). Values without an offset
 * get `defaultOffset`. Unparseable values are returned unchanged.
 */
export function toIsoDate(value: string | null | undefined, defaultOffset = '+00:00'): string {
  if (value === null || value === undefined || value.trim() === '') return '';
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!m) return value;
  let offset = m[4] ?? defaultOffset;
  if (/^z$/i.test(offset)) offset = '+00:00';
  else if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return `${m[1]}T${m[2]}${m[3] ?? ':00'}${offset}`;
}

/** True for an official wilaya code given as number or numeric string (`1`–`58`). */
export function isWilayaCode(value: string | number): boolean {
  const n = typeof value === 'number' ? value : /^\d{1,2}$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 58;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function randomUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/** Sorts events by `at` ascending (oldest first); stable for equal/unparseable dates. */
export function sortEventsAscending(events: TrackingEvent[]): TrackingEvent[] {
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => {
      if (!Number.isNaN(a.t) && !Number.isNaN(b.t) && a.t !== b.t) return a.t - b.t;
      if (Number.isNaN(a.t) || Number.isNaN(b.t)) {
        const cmp = a.e.at.localeCompare(b.e.at);
        if (cmp !== 0) return cmp;
      }
      return a.i - b.i;
    })
    .map(({ e }) => e);
}

/** Adds `raw` to a model only when enabled. */
export function withRaw<T extends object>(model: T, raw: unknown, includeRaw: boolean): T & { raw?: unknown } {
  return includeRaw ? { ...model, raw } : model;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0;
}

/** Client-side validation of `ParcelInput` (CONTRACT.md §5 rule 1). Throws before any HTTP call. */
export function validateParcelInput(input: ParcelInput, provider: string): void {
  const errors: ShippingErrorDetail[] = [];
  if (!input || typeof input !== 'object') {
    throw new ShippingError('VALIDATION_ERROR', 'ParcelInput must be an object', { provider });
  }

  if (!nonEmpty(input.recipientName)) errors.push({ field: 'recipientName', message: 'recipientName is required' });
  if (!nonEmpty(input.phone)) errors.push({ field: 'phone', message: 'phone is required' });
  if (!nonEmpty(input.address)) errors.push({ field: 'address', message: 'address is required' });

  const hasWilayaId = nonEmpty(input.wilayaId);
  const hasWilayaName = nonEmpty(input.wilayaName);
  if (hasWilayaId === hasWilayaName) {
    errors.push({ field: 'wilayaId', message: 'Exactly one of wilayaId / wilayaName is required' });
  }

  const hasCommuneId = nonEmpty(input.communeId);
  const hasCommuneName = nonEmpty(input.communeName);
  if (hasCommuneId === hasCommuneName) {
    errors.push({ field: 'communeId', message: 'Exactly one of communeId / communeName is required' });
  }

  const hasProductName = nonEmpty(input.productName);
  const hasProductList = Array.isArray(input.productList) && input.productList.length > 0;
  if (hasProductName === hasProductList) {
    errors.push({ field: 'productName', message: 'Exactly one of productName / productList is required' });
  }
  if (hasProductList) {
    input.productList!.forEach((item, i) => {
      if (!nonEmpty(item?.name)) errors.push({ field: `productList[${i}].name`, message: 'name is required' });
      if (!Number.isInteger(item?.quantity) || item.quantity < 1) {
        errors.push({ field: `productList[${i}].quantity`, message: 'quantity must be an integer ≥ 1' });
      }
    });
  }

  if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0) {
    errors.push({ field: 'price', message: 'price must be a number ≥ 0' });
  }

  for (const field of ['weight', 'length', 'width', 'height'] as const) {
    const v = input[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      errors.push({ field, message: `${field} must be a number ≥ 0` });
    }
  }

  if (input.isStopDesk && !nonEmpty(input.stopDeskId)) {
    errors.push({ field: 'stopDeskId', message: 'stopDeskId is required when isStopDesk is true' });
  }

  if (errors.length > 0) {
    throw new ShippingError('VALIDATION_ERROR', errors.map((e) => e.message).join('; '), {
      details: errors,
      provider,
    });
  }
}

/** Product description string, for carriers that take free text. */
export function productDescription(input: ParcelInput): string {
  if (input.productName) return input.productName.trim();
  return (input.productList ?? [])
    .map((p) => (p.quantity > 1 ? `${p.name} x${p.quantity}` : p.name))
    .join(', ');
}
