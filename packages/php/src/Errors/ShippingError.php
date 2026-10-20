<?php

declare(strict_types=1);

namespace DzDelivery\Errors;

/**
 * Single error type thrown by every provider (CONTRACT.md §2.8 / §3).
 *
 * `$code` holds the normalized string code (e.g. "NOT_FOUND"), which is why
 * it is redeclared as public and untyped on top of \Exception::$code.
 */
class ShippingError extends \RuntimeException
{
    public const AUTH_FAILED = 'AUTH_FAILED';
    public const VALIDATION_ERROR = 'VALIDATION_ERROR';
    public const NOT_FOUND = 'NOT_FOUND';
    public const RATE_LIMITED = 'RATE_LIMITED';
    public const NOT_SUPPORTED = 'NOT_SUPPORTED';
    public const PROVIDER_ERROR = 'PROVIDER_ERROR';
    public const NETWORK_ERROR = 'NETWORK_ERROR';
    public const UNKNOWN = 'UNKNOWN';

    /** @var string */
    public $code;

    /** @var string */
    public $message;

    /**
     * @param array<int|string, mixed>|null $details
     */
    public function __construct(
        string $code,
        string $message,
        public readonly ?int $httpStatus = null,
        public readonly ?array $details = null,
        public readonly mixed $raw = null,
        public readonly ?string $provider = null,
        ?\Throwable $previous = null,
        /** Seconds to wait before retrying (from the `Retry-After` header). */
        public readonly ?int $retryAfter = null,
    ) {
        parent::__construct($message, 0, $previous);
        $this->code = $code;
        $this->message = $message;
    }

    public static function codeForHttpStatus(int $status): string
    {
        return match (true) {
            $status === 400, $status === 422 => self::VALIDATION_ERROR,
            $status === 401, $status === 403 => self::AUTH_FAILED,
            $status === 404 => self::NOT_FOUND,
            $status === 429 => self::RATE_LIMITED,
            $status >= 500 => self::PROVIDER_ERROR,
            default => self::UNKNOWN,
        };
    }

    /** `Retry-After` header (delay in seconds or HTTP date) → whole seconds, if parseable. */
    public static function parseRetryAfter(?string $value, ?int $now = null): ?int
    {
        $value = trim((string) $value);
        if ($value === '') {
            return null;
        }
        if (ctype_digit($value)) {
            return (int) $value;
        }
        $at = strtotime($value);

        return $at === false ? null : max(0, $at - ($now ?? time()));
    }

    public static function validation(string $message, ?string $provider = null, ?string $field = null): self
    {
        $details = $field !== null ? [['field' => $field, 'message' => $message]] : null;

        return new self(self::VALIDATION_ERROR, $message, null, $details, null, $provider);
    }

    public static function notFound(string $message, ?string $provider = null): self
    {
        return new self(self::NOT_FOUND, $message, null, null, null, $provider);
    }

    public static function notSupported(string $message, ?string $provider = null): self
    {
        return new self(self::NOT_SUPPORTED, $message, null, null, null, $provider);
    }

    public static function providerError(string $message, ?string $provider = null, mixed $raw = null): self
    {
        return new self(self::PROVIDER_ERROR, $message, null, null, $raw, $provider);
    }
}
