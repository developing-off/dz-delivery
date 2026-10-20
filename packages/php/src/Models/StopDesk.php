<?php

declare(strict_types=1);

namespace DzDelivery\Models;

/** A stop desk / pickup point. `$id` is the value to pass as `ParcelInput::$stopDeskId`. */
final class StopDesk
{
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly ?string $address = null,
        public readonly ?string $communeId = null,
        public readonly ?string $wilayaId = null,
        public readonly mixed $raw = null,
    ) {
    }
}
