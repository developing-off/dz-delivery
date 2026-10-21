<?php

declare(strict_types=1);

namespace DzDelivery\Models;

use DzDelivery\Errors\ShippingError;

/**
 * Input to createParcel (CONTRACT.md §2.1).
 */
final class ParcelInput
{
    /** @var ProductItem[]|null */
    public readonly ?array $productList;

    /**
     * @param array<ProductItem|array<string, mixed>>|null $productList
     */
    public function __construct(
        public readonly string $recipientName,
        public readonly string $phone,
        public readonly string $address,
        public readonly int|float $price,
        public readonly string|int|null $wilayaId = null,
        public readonly ?string $wilayaName = null,
        public readonly string|int|null $communeId = null,
        public readonly ?string $communeName = null,
        public readonly ?string $productName = null,
        ?array $productList = null,
        public readonly ?string $phone2 = null,
        public readonly int|float|null $weight = null,
        public readonly int|float|null $length = null,
        public readonly int|float|null $width = null,
        public readonly int|float|null $height = null,
        public readonly bool $isStopDesk = false,
        public readonly ?string $stopDeskId = null,
        public readonly ?string $remark = null,
        public readonly ?string $orderId = null,
        /** Default stock mode for products that omit ProductItem::$stockType (ZRExpress). */
        public readonly ?string $stockType = null,
    ) {
        $this->productList = $productList === null
            ? null
            : array_values(array_map([ProductItem::class, 'from'], $productList));
    }

    /**
     * Builds an input from an array and validates it (throws VALIDATION_ERROR).
     */
    public static function from(self|array $input, ?string $provider = null): self
    {
        if (is_array($input)) {
            foreach (['recipientName', 'phone', 'address', 'price'] as $field) {
                if (!array_key_exists($field, $input) || $input[$field] === null || $input[$field] === '') {
                    throw ShippingError::validation("$field is required", $provider, $field);
                }
            }
            if (!is_numeric($input['price'])) {
                throw ShippingError::validation('price must be a number', $provider, 'price');
            }

            $input = new self(
                recipientName: (string) $input['recipientName'],
                phone: (string) $input['phone'],
                address: (string) $input['address'],
                price: $input['price'] + 0,
                wilayaId: self::idOrNull($input['wilayaId'] ?? null),
                wilayaName: self::stringOrNull($input['wilayaName'] ?? null),
                communeId: self::idOrNull($input['communeId'] ?? null),
                communeName: self::stringOrNull($input['communeName'] ?? null),
                productName: self::stringOrNull($input['productName'] ?? null),
                productList: $input['productList'] ?? null,
                phone2: self::stringOrNull($input['phone2'] ?? null),
                weight: self::numberOrNull($input['weight'] ?? null),
                length: self::numberOrNull($input['length'] ?? null),
                width: self::numberOrNull($input['width'] ?? null),
                height: self::numberOrNull($input['height'] ?? null),
                isStopDesk: (bool) ($input['isStopDesk'] ?? false),
                stopDeskId: isset($input['stopDeskId']) ? (string) $input['stopDeskId'] : null,
                remark: self::stringOrNull($input['remark'] ?? null),
                orderId: isset($input['orderId']) ? (string) $input['orderId'] : null,
                stockType: self::stockTypeOrNull($input['stockType'] ?? null, $provider),
            );
        }

        $input->validate($provider);

        return $input;
    }

    public function validate(?string $provider = null): void
    {
        $fail = static fn (string $field, string $message) => ShippingError::validation($message, $provider, $field);

        if (trim($this->recipientName) === '') {
            throw $fail('recipientName', 'recipientName is required');
        }
        if (trim($this->phone) === '') {
            throw $fail('phone', 'phone is required');
        }
        if (trim($this->address) === '') {
            throw $fail('address', 'address is required');
        }
        if ($this->price < 0) {
            throw $fail('price', 'price must be >= 0');
        }
        if (($this->wilayaId === null) === ($this->wilayaName === null)) {
            throw $fail('wilayaId', 'Exactly one of wilayaId / wilayaName is required');
        }
        if (($this->communeId === null) === ($this->communeName === null)) {
            throw $fail('communeId', 'Exactly one of communeId / communeName is required');
        }
        $hasList = $this->productList !== null && $this->productList !== [];
        if (($this->productName === null) === !$hasList) {
            throw $fail('productName', 'Exactly one of productName / productList is required');
        }
        if ($this->stockType !== null && !in_array($this->stockType, ['none', 'local', 'warehouse'], true)) {
            throw $fail('stockType', 'stockType must be one of: none, local, warehouse');
        }
        foreach ($this->productList ?? [] as $i => $item) {
            if (trim($item->name) === '') {
                throw $fail("productList.$i.name", 'productList[].name is required');
            }
            if ($item->quantity < 1) {
                throw $fail("productList.$i.quantity", 'productList[].quantity must be >= 1');
            }
            if ($item->stockType !== null && !in_array($item->stockType, ['none', 'local', 'warehouse'], true)) {
                throw $fail("productList.$i.stockType", 'stockType must be one of: none, local, warehouse');
            }
        }
        if ($this->isStopDesk && ($this->stopDeskId === null || $this->stopDeskId === '')) {
            throw $fail('stopDeskId', 'stopDeskId is required when isStopDesk is true');
        }
    }

    /**
     * Products as a list: productName becomes a single item priced at `price`.
     *
     * @return ProductItem[]
     */
    public function products(): array
    {
        if ($this->productList !== null && $this->productList !== []) {
            return $this->productList;
        }

        return [new ProductItem((string) $this->productName, 1, $this->price)];
    }

    /** Products as a single string: productName, or productList names joined. */
    public function productDescription(): string
    {
        if ($this->productName !== null) {
            return $this->productName;
        }

        return implode(', ', array_map(
            static fn (ProductItem $p) => $p->quantity > 1 ? "{$p->name} x{$p->quantity}" : $p->name,
            $this->productList ?? [],
        ));
    }

    private static function idOrNull(mixed $value): string|int|null
    {
        if ($value === null || $value === '') {
            return null;
        }

        return is_int($value) ? $value : (string) $value;
    }

    private static function stringOrNull(mixed $value): ?string
    {
        return $value === null || $value === '' ? null : (string) $value;
    }

    private static function numberOrNull(mixed $value): int|float|null
    {
        return is_numeric($value) ? $value + 0 : null;
    }

    private static function stockTypeOrNull(mixed $value, ?string $provider): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        $stockType = (string) $value;
        if (!in_array($stockType, ['none', 'local', 'warehouse'], true)) {
            throw ShippingError::validation(
                'stockType must be one of: none, local, warehouse',
                $provider,
                'stockType',
            );
        }

        return $stockType;
    }
}
