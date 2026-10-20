<?php

declare(strict_types=1);

namespace DzDelivery\Models;

final class TrackResult
{
    /**
     * @param TrackingEvent[] $events Oldest first.
     */
    public function __construct(
        public readonly Parcel $parcel,
        public readonly array $events = [],
    ) {
    }
}
