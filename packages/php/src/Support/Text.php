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

    /**
     * Spelling-tolerant key for Algerian place names: key(), then vowels dropped and doubled
     * letters collapsed, so transliteration variants meet ("Bab Ezzouar" / "Bab Azzouar" →
     * "bzr"). MUST stay identical to the TS `looseNameKey`.
     */
    public static function looseKey(string $value): string
    {
        $consonants = preg_replace('/[aeiouy]/', '', self::key($value)) ?? '';

        return preg_replace('/(.)\1+/', '$1', $consonants) ?? '';
    }

    /**
     * The single item whose name has the same looseKey() as $name. Null when none or several
     * match, or when the key is too short (< 3) to be meaningful: never guesses between two
     * communes. Use only after an exact match failed.
     *
     * @template T
     * @param iterable<T> $items
     * @param callable(T): string $nameOf
     * @return T|null
     */
    public static function findLoosely(iterable $items, string $name, callable $nameOf): mixed
    {
        $wanted = self::looseKey($name);
        if (strlen($wanted) < 3) {
            return null;
        }
        $hits = [];
        foreach ($items as $item) {
            if (self::looseKey($nameOf($item)) === $wanted) {
                $hits[] = $item;
            }
        }

        return count($hits) === 1 ? $hits[0] : null;
    }
}
