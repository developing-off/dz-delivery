<?php

declare(strict_types=1);

namespace DzDelivery\Models;

use DzDelivery\Errors\ShippingError;

final class StopDeskQuery
{
    public function __construct(
        /** Wilaya: provider id, official code 1–58, or name. */
        public readonly string|int $wilayaId,
        /** Commune: provider id or name. Required by some carriers (Maystro). */
        public readonly string|int|null $communeId = null,
    ) {
    }

    public static function from(self|array $query, ?string $provider = null): self
    {
        if ($query instanceof self) {
            return $query;
        }

        $wilaya = $query['wilayaId'] ?? null;
        if ($wilaya === null || $wilaya === '') {
            throw ShippingError::validation('wilayaId is required', $provider, 'wilayaId');
        }

        return new self(
            wilayaId: $wilaya,
            communeId: ($query['communeId'] ?? '') === '' ? null : $query['communeId'],
        );
    }
}
