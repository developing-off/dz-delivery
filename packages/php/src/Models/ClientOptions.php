<?php

declare(strict_types=1);

namespace DzDelivery\Models;

/**
 * Common client options (CONTRACT.md §6) plus the provider-specific
 * credentials/settings passed to ClientFactory::create().
 */
final class ClientOptions
{
    public const DEFAULT_TIMEOUT_MS = 15000;

    private const COMMON_KEYS = ['baseUrl', 'timeoutMs', 'includeRaw', 'handler'];

    /**
     * @param array<string, mixed> $config Provider-specific keys (apiKey, tenant, apiId, ...).
     * @param callable|null $handler Guzzle handler (e.g. a HandlerStack with a MockHandler) — mainly for tests.
     */
    public function __construct(
        public readonly ?string $baseUrl = null,
        public readonly int $timeoutMs = self::DEFAULT_TIMEOUT_MS,
        public readonly bool $includeRaw = true,
        public readonly array $config = [],
        public readonly mixed $handler = null,
    ) {
    }

    /**
     * @param array<string, mixed> $options
     */
    public static function fromArray(array $options): self
    {
        return new self(
            baseUrl: isset($options['baseUrl']) ? (string) $options['baseUrl'] : null,
            timeoutMs: isset($options['timeoutMs']) ? (int) $options['timeoutMs'] : self::DEFAULT_TIMEOUT_MS,
            includeRaw: (bool) ($options['includeRaw'] ?? true),
            config: array_diff_key($options, array_flip(self::COMMON_KEYS)),
            handler: $options['handler'] ?? null,
        );
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->config[$key] ?? $default;
    }
}
