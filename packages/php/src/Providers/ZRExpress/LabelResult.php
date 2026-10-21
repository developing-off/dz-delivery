<?php

declare(strict_types=1);

namespace DzDelivery\Providers\ZRExpress;

/** ZRExpress-only label generation result. */
final class LabelResult
{
    /**
     * @param list<array{trackingNumber: string, fileUrl: string}>|null $labels
     * @param list<string> $failedTrackingNumbers
     */
    public function __construct(
        public readonly ?string $fileUrl = null,
        public readonly ?array $labels = null,
        public readonly array $failedTrackingNumbers = [],
        public readonly mixed $raw = null,
    ) {
    }
}
