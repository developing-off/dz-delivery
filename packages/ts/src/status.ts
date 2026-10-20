import type { ParcelStatus } from './types';

/**
 * Case-, accent- and separator-insensitive comparison key, identical to the PHP
 * package's `Text::key`: `OutForDelivery` / `out_for_delivery` → `outfordelivery`,
 * `Prêt à expédier` → `pretaexpedier`.
 */
export function normalizeStatusKey(value: string): string {
  return value
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface StatusMapperOptions {
  /** Exact native → unified table (keys are normalized automatically). */
  exact: Record<string, ParcelStatus>;
  /** Checked after `exact`, in order: normalized key starts with the prefix. */
  prefixes?: Array<[prefix: string, status: ParcelStatus]>;
  /** Checked last, in order: normalized key contains the keyword. */
  keywords?: Array<[keyword: string, status: ParcelStatus]>;
}

export type StatusMapper = (native: string | null | undefined) => ParcelStatus;

/** Builds a mapper that never throws: anything not matched maps to `unknown`. */
export function createStatusMapper({ exact, prefixes = [], keywords = [] }: StatusMapperOptions): StatusMapper {
  const table = new Map<string, ParcelStatus>();
  for (const [key, status] of Object.entries(exact)) table.set(normalizeStatusKey(key), status);
  const normPrefixes = prefixes.map(([p, s]) => [normalizeStatusKey(p), s] as const);
  const normKeywords = keywords.map(([k, s]) => [normalizeStatusKey(k), s] as const);

  return (native) => {
    if (typeof native !== 'string') return 'unknown';
    const key = normalizeStatusKey(native);
    if (key === '') return 'unknown';
    const hit = table.get(key);
    if (hit) return hit;
    for (const [prefix, status] of normPrefixes) if (key.startsWith(prefix)) return status;
    for (const [keyword, status] of normKeywords) if (key.includes(keyword)) return status;
    return 'unknown';
  };
}
