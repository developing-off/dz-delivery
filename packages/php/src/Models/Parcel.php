<?php

declare(strict_types=1);

namespace DzDelivery\Models;

final class Parcel
{
    public function __construct(
        public readonly string $id,
        public readonly string $trackingNumber,
        public readonly string $status,
        public readonly string $provider,
        public readonly mixed $raw = null,
    ) {
    }
}
