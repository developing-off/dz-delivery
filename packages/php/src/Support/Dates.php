<?php

declare(strict_types=1);

namespace DzDelivery\Support;

use DzDelivery\Errors\ShippingError;

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

    /** Compares two dates as instants (offsets respected); unparseable values compare as strings. */
    public static function compare(string $a, string $b): int
    {
        $ta = strtotime($a);
        $tb = strtotime($b);

        return $ta !== false && $tb !== false ? $ta <=> $tb : strcmp($a, $b);
    }

    /**
     * Validates a carrier base URL: credentials go in headers, so only https is accepted.
     *
     * @throws ShippingError VALIDATION_ERROR
     */
    public static function requireHttps(string $baseUrl, string $provider): string
    {
        $parts = parse_url($baseUrl);
        if (
            !is_array($parts) || strtolower($parts['scheme'] ?? '') !== 'https' || ($parts['host'] ?? '') === ''
            || isset($parts['user']) || isset($parts['pass'])
        ) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                "baseUrl must be an https URL, got \"$baseUrl\"",
                null,
                [['field' => 'baseUrl', 'message' => 'baseUrl must be an https URL']],
                null,
                $provider,
            );
        }

        return rtrim($baseUrl, '/');
    }
}
