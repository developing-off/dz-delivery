<?php

declare(strict_types=1);

namespace DzDelivery\Support;

use DzDelivery\Errors\ShippingError;

/**
 * Algerian phone normalization: `0550123456` ↔ `+213550123456`.
 * Mobiles have 9 national digits (5/6/7xx...), landlines 8.
 */
final class Phone
{
    /** National significant number (without leading 0 / +213), or null if not Algerian. */
    public static function nationalNumber(string $phone): ?string
    {
        $digits = preg_replace('/[\s\-.()\/]/', '', trim($phone)) ?? '';

        if (str_starts_with($digits, '+213')) {
            $national = substr($digits, 4);
        } elseif (str_starts_with($digits, '00213')) {
            $national = substr($digits, 5);
        } elseif (str_starts_with($digits, '213') && strlen($digits) >= 11) {
            $national = substr($digits, 3);
        } elseif (str_starts_with($digits, '0')) {
            $national = substr($digits, 1);
        } else {
            $national = $digits;
        }

        $national = ltrim($national, '0');

        return preg_match('/^\d{8,9}$/', $national) === 1 ? $national : null;
    }

    /** `0550123456` → `+213550123456`. */
    public static function toInternational(string $phone, ?string $provider = null, string $field = 'phone'): string
    {
        $national = self::nationalNumber($phone);
        if ($national === null) {
            throw ShippingError::validation("Invalid Algerian phone number: $phone", $provider, $field);
        }

        return '+213' . $national;
    }

    /** `+213550123456` → `0550123456`. */
    public static function toLocal(string $phone, ?string $provider = null, string $field = 'phone'): string
    {
        $national = self::nationalNumber($phone);
        if ($national === null) {
            throw ShippingError::validation("Invalid Algerian phone number: $phone", $provider, $field);
        }

        return '0' . $national;
    }
}
