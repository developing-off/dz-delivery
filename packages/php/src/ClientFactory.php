<?php

declare(strict_types=1);

namespace DzDelivery;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\ClientOptions;
use DzDelivery\Providers\EcotrackProvider;
use DzDelivery\Providers\MaystroProvider;
use DzDelivery\Providers\YalidineProvider;
use DzDelivery\Providers\ZRExpressProvider;

final class ClientFactory
{
    /** @var array<string, class-string<ShippingProviderInterface>> */
    private const PROVIDERS = [
        ZRExpressProvider::NAME => ZRExpressProvider::class,
        YalidineProvider::NAME => YalidineProvider::class,
        MaystroProvider::NAME => MaystroProvider::class,
        EcotrackProvider::NAME => EcotrackProvider::class,
    ];

    /**
     * ClientFactory::create('zrexpress', ['apiKey' => ..., 'tenant' => ...]);
     * ClientFactory::create('yalidine', ['apiId' => ..., 'apiToken' => ..., 'fromWilayaId' => 16]);
     * ClientFactory::create('maystro', ['apiToken' => ...]);
     * ClientFactory::create('ecotrack', ['token' => ..., 'courier' => 'dhd']); // or 'baseUrl' => 'https://x.ecotrack.dz'
     *
     * @param array<string, mixed>|ClientOptions $options Credentials + common options
     *        (baseUrl, timeoutMs, includeRaw).
     */
    public static function create(string $provider, array|ClientOptions $options = []): ShippingProviderInterface
    {
        $key = strtolower(trim($provider));
        $class = self::PROVIDERS[$key] ?? null;
        if ($class === null) {
            throw ShippingError::notSupported(
                "Unknown provider \"$provider\". Supported: " . implode(', ', self::providers()),
                $key,
            );
        }

        return new $class($options instanceof ClientOptions ? $options : ClientOptions::fromArray($options));
    }

    /** @return list<string> */
    public static function providers(): array
    {
        return array_keys(self::PROVIDERS);
    }
}
