<?php

declare(strict_types=1);

namespace DzDelivery\Providers\Maystro;

/** Maystro-only: shipping labels (bordereaux) as one PDF, a page per order found. */
final class MaystroLabels
{
    /**
     * @param string $data PDF bytes: write them to a file or send them as the HTTP response body.
     * @param int $labelCount Labels in the PDF; lower than the references sent when some were not found.
     */
    public function __construct(
        public readonly string $data,
        public readonly int $labelCount,
        public readonly string $contentType = 'application/pdf',
    ) {
    }
}
