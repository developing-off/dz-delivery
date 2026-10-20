import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/fixtures');

export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` stub that serves `responses` in order and records every request. */
export function mockFetch(responses: MockResponse[]) {
  const queue = [...responses];
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request #${calls.length}: ${init?.method} ${String(input)}`);
    const noBody = next.status === 204 || next.body === null || next.body === undefined;
    return new Response(noBody ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, remaining: () => queue.length };
}

export function readJson<T = unknown>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, ...parts), 'utf8')) as T;
}

export interface FixtureCase {
  provider: string;
  method: string;
  name: string;
  /** Per-case client options, merged over `<provider>/config.json`. */
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
  native: MockResponse[];
  requests: Array<{
    method: string;
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
  }>;
  expected: { result?: unknown; error?: Record<string, unknown> };
}

/** Loads every `<method>/<case>.*.json` fixture of a provider. */
export function loadFixtureCases(provider: string): FixtureCase[] {
  const root = join(FIXTURES_DIR, provider);
  const cases: FixtureCase[] = [];
  for (const method of readdirSync(root, { withFileTypes: true })) {
    if (!method.isDirectory()) continue;
    const dir = join(root, method.name);
    const names = new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith('.expected.json'))
        .map((f) => f.replace(/\.expected\.json$/, '')),
    );
    for (const name of names) {
      const file = (kind: string) => join(dir, `${name}.${kind}.json`);
      const load = (kind: string) => JSON.parse(readFileSync(file(kind), 'utf8'));
      cases.push({
        provider,
        method: method.name,
        name,
        config: existsSync(file('config')) ? load('config') : undefined,
        input: existsSync(file('input')) ? load('input') : undefined,
        native: existsSync(file('native')) ? load('native') : [],
        requests: existsSync(file('request')) ? load('request') : [],
        expected: load('expected'),
      });
    }
  }
  return cases;
}

/** Recursively removes `raw` keys (not part of the compared contract). */
export function stripRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRaw);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'raw') out[k] = stripRaw(v);
    return out;
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the paths where `actual` does not contain `expected` (same semantics as the PHP
 * suite's `assertSubset`): every key/index listed in `expected` must exist and match;
 * unlisted fields are ignored. The string `"<uuid>"` matches any UUID.
 */
export function subsetMismatches(expected: unknown, actual: unknown, path = '$'): string[] {
  if (expected === '<uuid>') {
    return typeof actual === 'string' && UUID_RE.test(actual) ? [] : [`${path}: expected a UUID, got ${JSON.stringify(actual)}`];
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${path}: expected an object/array, got ${JSON.stringify(actual)}`];
    const a = actual as Record<string, unknown>;
    return Object.entries(expected).flatMap(([k, v]) =>
      k in a ? subsetMismatches(v, a[k], `${path}.${k}`) : [`${path}.${k}: missing`],
    );
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}
