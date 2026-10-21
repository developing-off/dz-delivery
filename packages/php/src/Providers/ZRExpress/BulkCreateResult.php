<?php

declare(strict_types=1);

namespace DzDelivery\Providers\ZRExpress;

use DzDelivery\Models\Parcel;

/** ZRExpress-only bulk create result (supports partial success). */
final class BulkCreateResult
{
    /**
     * @param list<Parcel> $successes
     * @param list<array{index: int, orderId?: string, error: array{code: string, message: string, errorCode?: string}}> $failures
     */
    public function __construct(
        public readonly array $successes,
        public readonly array $failures,
        public readonly mixed $raw = null,
    ) {
    }
}
