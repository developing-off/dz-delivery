<?php

declare(strict_types=1);

namespace DzDelivery\Support;

use DzDelivery\Models\HealthCheckResult;

/**
 * Shared `healthCheck` body: clear the wilayas cache, re-fetch, measure latency.
 * CONTRACT.md §5 — always hits the network.
 */
final class Health
{
    /**
     * @param callable(): void $clearCache
     * @param callable(): mixed $fetchWilayas
     */
    public static function probeWilayas(string $provider, callable $clearCache, callable $fetchWilayas): HealthCheckResult
    {
        $clearCache();
        $started = (int) floor(microtime(true) * 1000);
        $fetchWilayas();
        $latencyMs = (int) floor(microtime(true) * 1000) - $started;

        return new HealthCheckResult(ok: true, provider: $provider, latencyMs: max(0, $latencyMs));
    }
}
