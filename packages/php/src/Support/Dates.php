<?php

declare(strict_types=1);

namespace DzDelivery\Support;

final class Dates
{
    /**
     * Converts a native date string to ISO 8601 with timezone. Strings without
     * an explicit offset are interpreted in $defaultTimezone. Unparseable
     * values are returned unchanged.
     */
    public static function toIso(?string $value, string $defaultTimezone = 'UTC'): string
    {
        if ($value === null || trim($value) === '') {
            return '';
        }
        try {
            $date = new \DateTimeImmutable($value, new \DateTimeZone($defaultTimezone));
        } catch (\Exception) {
            return $value;
        }

        return $date->format(\DateTimeInterface::ATOM);
    }
}
