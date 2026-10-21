<?php

declare(strict_types=1);

namespace DzDelivery\Providers\ZRExpress;

use DzDelivery\Errors\ShippingError;
use DzDelivery\Support\StatusMapper;

/**
 * ZRExpress webhook receive helpers (Svix / Standard Webhooks).
 * Zero runtime dependency on the `svix` package — uses hash_hmac.
 *
 * Always pass the raw request body (before JSON re-encode).
 */
final class Webhook
{
    public const TOLERANCE_SEC = 300;

    /**
     * @param array<string, mixed>|object $payload Decoded JSON
     */
    public static function parse(mixed $payload): WebhookEvent
    {
        if (!is_array($payload)) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                'ZRExpress webhook payload must be a JSON object',
                null,
                null,
                $payload,
                'zrexpress',
            );
        }

        $type = self::str($payload['eventType'] ?? $payload['type'] ?? null);
        if ($type === null || $type === '') {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                'ZRExpress webhook missing eventType',
                null,
                null,
                $payload,
                'zrexpress',
            );
        }

        $data = is_array($payload['data'] ?? null) ? $payload['data'] : null;
        $stateName = null;
        if (is_array($data) && is_array($data['state'] ?? null)) {
            $stateName = self::str($data['state']['name'] ?? null);
        }

        return new WebhookEvent(
            type: $type,
            parcelId: is_array($data) ? self::str($data['id'] ?? null) : null,
            trackingNumber: is_array($data) ? self::str($data['trackingNumber'] ?? null) : null,
            orderId: is_array($data) ? self::str($data['externalId'] ?? null) : null,
            status: $stateName !== null ? StatusMapper::zrexpress($stateName) : null,
            occurredAt: self::str($payload['occurredAt'] ?? null),
            raw: $payload,
        );
    }

    /**
     * @param array<string, string|string[]|null>|object $headers
     */
    public static function verify(
        string $rawBody,
        array|object $headers,
        string $secret,
        ?int $toleranceSec = null,
        ?int $now = null,
    ): WebhookEvent {
        if (trim($secret) === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'ZRExpress webhook secret is required', null, null, null, 'zrexpress');
        }

        $msgId = self::header($headers, 'svix-id') ?? self::header($headers, 'webhook-id');
        $msgTimestamp = self::header($headers, 'svix-timestamp') ?? self::header($headers, 'webhook-timestamp');
        $msgSignature = self::header($headers, 'svix-signature') ?? self::header($headers, 'webhook-signature');

        if ($msgId === null || $msgTimestamp === null || $msgSignature === null) {
            throw new ShippingError(
                ShippingError::AUTH_FAILED,
                'Missing Svix webhook headers (svix-id / svix-timestamp / svix-signature)',
                null,
                null,
                null,
                'zrexpress',
            );
        }

        if (!is_numeric($msgTimestamp)) {
            throw new ShippingError(ShippingError::VALIDATION_ERROR, 'Invalid webhook timestamp', null, null, null, 'zrexpress');
        }

        $ts = (int) $msgTimestamp;
        $nowSec = $now ?? time();
        $tolerance = $toleranceSec ?? self::TOLERANCE_SEC;
        if (abs($nowSec - $ts) > $tolerance) {
            throw new ShippingError(
                ShippingError::AUTH_FAILED,
                'Webhook timestamp outside allowed tolerance',
                null,
                [['field' => 'svix-timestamp', 'message' => "skew > {$tolerance}s"]],
                null,
                'zrexpress',
            );
        }

        $key = self::decodeSecret($secret);
        $toSign = $msgId . '.' . $msgTimestamp . '.' . $rawBody;
        $expected = hash_hmac('sha256', $toSign, $key, true);
        $expectedB64 = base64_encode($expected);

        $ok = false;
        foreach (preg_split('/\s+/', trim($msgSignature)) ?: [] as $part) {
            if ($part === '') {
                continue;
            }
            $sig = $part;
            if (str_contains($part, ',')) {
                $sig = explode(',', $part, 2)[1] ?? $part;
            }
            $sig = trim($sig);
            if ($sig !== '' && (self::hashEqualsB64($sig, $expectedB64) || self::hashEqualsHex($sig, $expected))) {
                $ok = true;
                break;
            }
        }

        if (!$ok) {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'Invalid ZRExpress webhook signature', null, null, null, 'zrexpress');
        }

        try {
            $parsed = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                'ZRExpress webhook body is not valid JSON',
                null,
                null,
                substr($rawBody, 0, 200),
                'zrexpress',
                $e,
            );
        }

        return self::parse($parsed);
    }

    private static function decodeSecret(string $secret): string
    {
        $trimmed = trim($secret);
        if (str_starts_with($trimmed, 'whsec_')) {
            $decoded = base64_decode(substr($trimmed, strlen('whsec_')), true);
            if ($decoded === false) {
                throw new ShippingError(ShippingError::AUTH_FAILED, 'Invalid whsec_ webhook secret', null, null, null, 'zrexpress');
            }

            return $decoded;
        }

        return $trimmed;
    }

    /** @param array<string, string|string[]|null>|object $headers */
    private static function header(array|object $headers, string $name): ?string
    {
        $lower = strtolower($name);
        if (is_object($headers) && method_exists($headers, 'get')) {
            $v = $headers->get($name) ?? $headers->get($lower);
            if (is_string($v) && trim($v) !== '') {
                return trim($v);
            }
        }
        foreach ((array) $headers as $k => $v) {
            if (strtolower((string) $k) !== $lower) {
                continue;
            }
            $value = is_array($v) ? ($v[0] ?? null) : $v;
            if (is_string($value) && trim($value) !== '') {
                return trim($value);
            }
        }

        return null;
    }

    private static function hashEqualsB64(string $a, string $b): bool
    {
        $ba = base64_decode($a, true);
        $bb = base64_decode($b, true);
        if ($ba === false || $bb === false || strlen($ba) !== strlen($bb)) {
            return false;
        }

        return hash_equals($bb, $ba);
    }

    private static function hashEqualsHex(string $a, string $expectedBinary): bool
    {
        if (!preg_match('/^[0-9a-f]+$/i', $a) || strlen($a) !== strlen($expectedBinary) * 2) {
            return false;
        }
        $ba = @hex2bin($a);
        if ($ba === false || strlen($ba) !== strlen($expectedBinary)) {
            return false;
        }

        return hash_equals($expectedBinary, $ba);
    }

    private static function str(mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        if (is_string($v)) {
            return $v;
        }
        if (is_int($v) || is_float($v)) {
            return (string) $v;
        }

        return null;
    }
}
