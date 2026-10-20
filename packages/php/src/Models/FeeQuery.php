<?php

declare(strict_types=1);

namespace DzDelivery\Models;

use DzDelivery\Errors\ShippingError;

final class FeeQuery
{
    public function __construct(
        public readonly string|int $toWilayaId,
        public readonly string|int|null $toCommuneId = null,
        public readonly string|int|null $fromWilayaId = null,
        public readonly int|float|null $weight = null,
        public readonly bool $isStopDesk = false,
        /** Package dimensions in cm, for carriers that bill volumetric weight. */
        public readonly int|float|null $length = null,
        public readonly int|float|null $width = null,
        public readonly int|float|null $height = null,
    ) {
    }

    public static function from(self|array $query, ?string $provider = null): self
    {
        if ($query instanceof self) {
            return $query;
        }

        $to = $query['toWilayaId'] ?? null;
        if ($to === null || $to === '') {
            throw ShippingError::validation('toWilayaId is required', $provider, 'toWilayaId');
        }

        return new self(
            toWilayaId: $to,
            toCommuneId: ($query['toCommuneId'] ?? '') === '' ? null : $query['toCommuneId'],
            fromWilayaId: ($query['fromWilayaId'] ?? '') === '' ? null : $query['fromWilayaId'],
            weight: is_numeric($query['weight'] ?? null) ? $query['weight'] + 0 : null,
            isStopDesk: (bool) ($query['isStopDesk'] ?? false),
            length: is_numeric($query['length'] ?? null) ? $query['length'] + 0 : null,
            width: is_numeric($query['width'] ?? null) ? $query['width'] + 0 : null,
            height: is_numeric($query['height'] ?? null) ? $query['height'] + 0 : null,
        );
    }
}
