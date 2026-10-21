<?php

declare(strict_types=1);

namespace DzDelivery\Models;

/** Result of listParcels (CONTRACT.md §2.12). */
final class ParcelListPage
{
    /**
     * @param list<Parcel> $parcels
     */
    public function __construct(
        public readonly array $parcels,
        public readonly int $page,
        public readonly int $pageSize,
        public readonly int $totalCount,
        public readonly bool $hasNext,
        public readonly mixed $raw = null,
    ) {
    }
}
