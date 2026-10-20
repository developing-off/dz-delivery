<?php

declare(strict_types=1);

namespace DzDelivery\Models;

/** Result of `healthCheck()` — CONTRACT.md §5. Failures throw ShippingError instead. */
final class HealthCheckResult
{
    public function __construct(
        public readonly bool $ok,
        public readonly string $provider,
        /** Round-trip duration in milliseconds. */
        public readonly int $latencyMs,
    ) {
    }
}
