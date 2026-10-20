<?php

declare(strict_types=1);

namespace DzDelivery\Models;

final class FeeQuote
{
    public readonly string $currency;

    public function __construct(
        public readonly int|float $deliveryFee,
        public readonly int|float|null $returnFee = null,
        public readonly int|float|null $stopDeskFee = null,
        public readonly mixed $raw = null,
    ) {
        $this->currency = 'DZD';
    }
}
