import { ShippingError, codeFromHttpStatus, parseRetryAfter } from './errors';
import type { ShippingErrorDetail } from './types';

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path relative to `baseUrl`, e.g. `/api/v1/parcels`. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** Provider hook that extracts a message / details from a native error body. */
export type ErrorBodyParser = (
  body: unknown,
  status: number,
) => { message?: string; details?: ShippingErrorDetail[] } | undefined;

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  parseError?: ErrorBodyParser;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpClient {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const { provider } = this.options;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ShippingError('NETWORK_ERROR', 'No fetch implementation available; pass `fetch` in the client config.', {
        provider,
      });
    }

    const url = this.buildUrl(req.path, req.query);
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: req.method,
        headers: { ...this.options.headers, ...req.headers },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new ShippingError(
        'NETWORK_ERROR',
        timedOut ? `Request timed out after ${timeoutMs} ms` : `Network error: ${(err as Error)?.message ?? String(err)}`,
        { provider, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let body: unknown = undefined;
    let parseFailed = false;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
        parseFailed = true;
      }
    }

    if (!res.ok) {
      const parsed = this.options.parseError?.(body, res.status);
      throw new ShippingError(
        codeFromHttpStatus(res.status),
        parsed?.message || `${provider} API responded with HTTP ${res.status}`,
        {
          httpStatus: res.status,
          details: parsed?.details && parsed.details.length > 0 ? parsed.details : undefined,
          raw: body,
          provider,
          retryAfter: res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined,
        },
      );
    }

    if (parseFailed) {
      throw new ShippingError('PROVIDER_ERROR', `${provider} API returned a non-JSON response`, {
        httpStatus: res.status,
        raw: body,
        provider,
      });
    }

    return { status: res.status, headers: res.headers, body: body as T };
  }
}
