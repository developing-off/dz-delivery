import type { HealthCheckResult } from '../types';

/**
 * Shared `healthCheck` body: clear the wilayas cache, re-fetch, measure latency.
 * CONTRACT.md §5 — always hits the network.
 */
export async function probeWilayasHealth(
  provider: string,
  clearCache: () => void,
  fetchWilayas: () => Promise<unknown>,
): Promise<HealthCheckResult> {
  clearCache();
  const started = Date.now();
  await fetchWilayas();
  return { ok: true, provider, latencyMs: Date.now() - started };
}
