<?php

declare(strict_types=1);

namespace DzDelivery\Providers\ZRExpress;

/** Parsed ZRExpress webhook event (after verify or parse). */
final class WebhookEvent
{
    public function __construct(
        public readonly string $type,
        public readonly ?string $parcelId = null,
        public readonly ?string $trackingNumber = null,
        public readonly ?string $orderId = null,
        public readonly ?string $status = null,
        public readonly ?string $occurredAt = null,
        public readonly mixed $raw = null,
    ) {
    }
}
