import type { ShippingErrorCode, ShippingErrorDetail } from './types';

export interface ShippingErrorOptions {
  httpStatus?: number;
  details?: ShippingErrorDetail[] | Record<string, unknown>;
  raw?: unknown;
  provider?: string;
  /** Seconds to wait before retrying (from the `Retry-After` header). */
  retryAfter?: number;
  cause?: unknown;
}

export class ShippingError extends Error {
  readonly code: ShippingErrorCode;
  readonly httpStatus?: number;
  readonly details?: ShippingErrorDetail[] | Record<string, unknown>;
  readonly raw?: unknown;
  readonly provider?: string;
  readonly retryAfter?: number;

  constructor(code: ShippingErrorCode, message: string, options: ShippingErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ShippingError';
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.details !== undefined) this.details = options.details;
    if (options.raw !== undefined) this.raw = options.raw;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isShippingError(value: unknown): value is ShippingError {
  return value instanceof ShippingError;
}

/** `Retry-After` header (delay in seconds or HTTP date) → whole seconds, if parseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Default HTTP status → error code mapping (CONTRACT.md §3). */
export function codeFromHttpStatus(status: number): ShippingErrorCode {
  if (status === 400 || status === 422) return 'VALIDATION_ERROR';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_ERROR';
  return 'UNKNOWN';
}
