<?php

declare(strict_types=1);

namespace DzDelivery\Support;

/**
 * Case/accent-insensitive comparison keys for names and native statuses.
 */
final class Text
{
    private const ACCENTS = [
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ä' => 'a', 'ã' => 'a', 'å' => 'a',
        'À' => 'a', 'Á' => 'a', 'Â' => 'a', 'Ä' => 'a', 'Ã' => 'a', 'Å' => 'a',
        'ç' => 'c', 'Ç' => 'c',
        'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e',
        'È' => 'e', 'É' => 'e', 'Ê' => 'e', 'Ë' => 'e',
        'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i',
        'Ì' => 'i', 'Í' => 'i', 'Î' => 'i', 'Ï' => 'i',
        'ñ' => 'n', 'Ñ' => 'n',
        'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'ö' => 'o', 'õ' => 'o',
        'Ò' => 'o', 'Ó' => 'o', 'Ô' => 'o', 'Ö' => 'o', 'Õ' => 'o',
        'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u',
        'Ù' => 'u', 'Ú' => 'u', 'Û' => 'u', 'Ü' => 'u',
        'ÿ' => 'y', 'Ÿ' => 'y', 'œ' => 'oe', 'Œ' => 'oe', 'æ' => 'ae', 'Æ' => 'ae',
    ];

    /** "Béjaïa" / "BEJAIA" / "bejaia " → "bejaia"; "Aïn M'lila" → "ainmlila". */
    public static function key(string $value): string
    {
        $value = strtolower(strtr($value, self::ACCENTS));

        return preg_replace('/[^a-z0-9]/', '', $value) ?? '';
    }
}
