<?php

declare(strict_types=1);

namespace DzDelivery\Models;

/**
 * Unified parcel statuses (CONTRACT.md §4). Values are plain strings so they
 * compare directly with the shared fixtures and the TypeScript package.
 */
final class ParcelStatus
{
    public const PENDING = 'pending';
    public const CREATED = 'created';
    public const IN_TRANSIT = 'in_transit';
    public const DELIVERED = 'delivered';
    public const RETURNED = 'returned';
    public const CANCELLED = 'cancelled';
    public const UNKNOWN = 'unknown';

    public const ALL = [
        self::PENDING,
        self::CREATED,
        self::IN_TRANSIT,
        self::DELIVERED,
        self::RETURNED,
        self::CANCELLED,
        self::UNKNOWN,
    ];

    private function __construct()
    {
    }
}
