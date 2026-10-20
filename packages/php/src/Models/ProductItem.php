<?php

declare(strict_types=1);

namespace DzDelivery\Models;

use DzDelivery\Errors\ShippingError;

final class ProductItem
{
    public function __construct(
        public readonly string $name,
        public readonly int $quantity = 1,
        public readonly int|float|null $unitPrice = null,
        public readonly ?string $sku = null,
    ) {
    }

    public static function from(self|array $item): self
    {
        if ($item instanceof self) {
            return $item;
        }

        if (!isset($item['name']) || !is_string($item['name'])) {
            throw ShippingError::validation('productList[].name is required', null, 'productList.name');
        }

        return new self(
            name: $item['name'],
            quantity: (int) ($item['quantity'] ?? 1),
            unitPrice: isset($item['unitPrice']) ? $item['unitPrice'] + 0 : null,
            sku: isset($item['sku']) ? (string) $item['sku'] : null,
        );
    }
}
