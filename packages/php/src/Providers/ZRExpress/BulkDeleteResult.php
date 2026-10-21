<?php

declare(strict_types=1);

namespace DzDelivery\Providers\ZRExpress;

/** ZRExpress-only bulk delete result (supports partial success). */
final class BulkDeleteResult
{
    /**
     * @param list<array{index: int, parcelId?: string, trackingNumber?: string}> $successes
     * @param list<array{index: int, error: array{code: string, message: string, errorCode?: string}}> $failures
     */
    public function __construct(
        public readonly array $successes,
        public readonly array $failures,
        public readonly mixed $raw = null,
    ) {
    }
}
