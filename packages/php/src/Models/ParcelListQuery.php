<?php

declare(strict_types=1);

namespace DzDelivery\Models;

use DzDelivery\Errors\ShippingError;

/** Input to listParcels (CONTRACT.md §2.11). */
final class ParcelListQuery
{
    public function __construct(
        public readonly int $page = 1,
        public readonly int $pageSize = 50,
        public readonly ?string $keyword = null,
        public readonly ?string $orderId = null,
        public readonly ?string $status = null,
        public readonly ?string $updatedSince = null,
        public readonly bool $allPages = false,
    ) {
    }

    /**
     * @param self|array<string, mixed>|null $query
     */
    public static function from(self|array|null $query, ?string $provider = null): self
    {
        if ($query instanceof self) {
            $query->validate($provider);

            return $query;
        }

        $query ??= [];
        $status = isset($query['status']) && $query['status'] !== '' ? (string) $query['status'] : null;
        $built = new self(
            page: max(1, (int) ($query['page'] ?? 1)),
            pageSize: max(1, (int) ($query['pageSize'] ?? 50)),
            keyword: isset($query['keyword']) && $query['keyword'] !== '' ? (string) $query['keyword'] : null,
            orderId: isset($query['orderId']) && $query['orderId'] !== '' ? (string) $query['orderId'] : null,
            status: $status,
            updatedSince: isset($query['updatedSince']) && $query['updatedSince'] !== ''
                ? (string) $query['updatedSince']
                : null,
            allPages: (bool) ($query['allPages'] ?? false),
        );
        $built->validate($provider);

        return $built;
    }

    public function validate(?string $provider = null): void
    {
        if ($this->page < 1) {
            throw ShippingError::validation('page must be >= 1', $provider, 'page');
        }
        if ($this->pageSize < 1) {
            throw ShippingError::validation('pageSize must be >= 1', $provider, 'pageSize');
        }
        if ($this->status !== null && !in_array($this->status, ParcelStatus::ALL, true)) {
            throw ShippingError::validation(
                'status must be a unified ParcelStatus',
                $provider,
                'status',
            );
        }
    }
}
