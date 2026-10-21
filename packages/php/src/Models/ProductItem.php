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
        public readonly ?string $productId = null,
        public readonly ?string $stockType = null,
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

        $stockType = isset($item['stockType']) ? (string) $item['stockType'] : null;
        if ($stockType !== null && $stockType !== '' && !in_array($stockType, ['none', 'local', 'warehouse'], true)) {
            throw ShippingError::validation(
                'stockType must be one of: none, local, warehouse',
                null,
                'productList.stockType',
            );
        }

        return new self(
            name: $item['name'],
            quantity: (int) ($item['quantity'] ?? 1),
            unitPrice: isset($item['unitPrice']) ? $item['unitPrice'] + 0 : null,
            sku: isset($item['sku']) ? (string) $item['sku'] : null,
            productId: isset($item['productId']) && $item['productId'] !== '' ? (string) $item['productId'] : null,
            stockType: $stockType !== null && $stockType !== '' ? $stockType : null,
        );
    }
}
