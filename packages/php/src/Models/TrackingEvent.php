<?php

declare(strict_types=1);

namespace DzDelivery\Models;

final class TrackingEvent
{
    public function __construct(
        public readonly string $status,
        public readonly string $label,
        public readonly string $at,
        public readonly mixed $raw = null,
    ) {
    }
}
