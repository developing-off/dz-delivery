<?php

declare(strict_types=1);

namespace DzDelivery\Models;

final class Location
{
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly ?string $parentId = null,
        public readonly ?string $code = null,
        public readonly mixed $raw = null,
    ) {
    }
}
