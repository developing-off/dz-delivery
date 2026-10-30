<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\ClientFactory;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Providers\EcomProvider;
use DzDelivery\Providers\EcotrackProvider;
use DzDelivery\Providers\MaystroProvider;
use DzDelivery\Providers\NoestProvider;
use DzDelivery\Providers\YalidineProvider;
use DzDelivery\Providers\ZRExpressProvider;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;
use PHPUnit\Framework\Attributes\DataProvider;

final class SupportTest extends TestCase
{
    /** @return iterable<string, array{string, string, string}> */
    public static function statuses(): iterable
    {
        foreach (['zrexpress', 'yalidine', 'maystro', 'ecotrack'] as $provider) {
            $table = json_decode((string) file_get_contents(self::fixturesDir() . "/$provider/statuses.json"), true);
            foreach ($table as $native => $unified) {
                yield "$provider: '$native'" => [$provider, (string) $native, $unified];
            }
        }
    }

    #[DataProvider('statuses')]
    public function testStatusMappingMatchesSharedFixtures(string $provider, string $native, string $unified): void
    {
        self::assertSame($unified, StatusMapper::map($provider, $native));
    }

    public function testPhoneNormalization(): void
    {
        self::assertSame('+213550123456', Phone::toInternational('0550123456'));
        self::assertSame('+213550123456', Phone::toInternational('+213 (0) 550-12-34-56'));
        self::assertSame('+213550123456', Phone::toInternational('00213550123456'));
        self::assertSame('+21321123456', Phone::toInternational('021 12 34 56'));
        self::assertSame('0550123456', Phone::toLocal('+213550123456'));
        self::assertNull(Phone::nationalNumber('12345'));
    }

    /** @return iterable<string, array{string, string}> docs/fixtures/loose-names.json, shared with the TS looseNameKey */
    public static function looseNames(): iterable
    {
        foreach (self::fixture('loose-names.json') as $name => $key) {
            yield (string) $name => [(string) $name, $key];
        }
    }

    #[DataProvider('looseNames')]
    public function testLooseKey(string $name, string $key): void
    {
        self::assertSame($key, Text::looseKey($name));
    }

    public function testFindLooselyOnlyReturnsAnUnambiguousMatch(): void
    {
        $names = ['Bab Azzouar', 'Draria', 'Ain Taya', 'Hussein Dey', 'Husein Dey'];
        $find = static fn (string $name) => Text::findLoosely($names, $name, static fn (string $n) => $n);

        self::assertSame('Bab Azzouar', $find('Bab Ezzouar'));
        self::assertNull($find('Dreria'));      // key "dr" too short
        self::assertNull($find('Hussein-Dey')); // two candidates
        self::assertNull($find('Atlantis'));
    }

    public function testFactoryCreatesProviders(): void
    {
        self::assertInstanceOf(ZRExpressProvider::class, ClientFactory::create('ZRExpress', ['apiKey' => 'k', 'tenant' => 't']));
        self::assertInstanceOf(YalidineProvider::class, ClientFactory::create('yalidine', ['apiId' => 'i', 'apiToken' => 't']));
        self::assertInstanceOf(MaystroProvider::class, ClientFactory::create('maystro', ['apiToken' => 't']));
        self::assertInstanceOf(EcotrackProvider::class, ClientFactory::create('ecotrack', ['token' => 't', 'courier' => 'dhd']));
        self::assertInstanceOf(NoestProvider::class, ClientFactory::create('noest', ['apiToken' => 't', 'userGuid' => 'g']));
        self::assertInstanceOf(EcomProvider::class, ClientFactory::create('ecom', ['apiKey' => 'k', 'apiToken' => 't']));
        self::assertSame(['zrexpress', 'yalidine', 'maystro', 'ecotrack', 'noest', 'ecom'], ClientFactory::providers());
    }

    public function testFactoryUnknownProviderIsNotSupported(): void
    {
        $this->expectExceptionObject(new ShippingError(ShippingError::NOT_SUPPORTED, 'Unknown provider "dhl". Supported: zrexpress, yalidine, maystro, ecotrack, noest, ecom'));
        ClientFactory::create('dhl');
    }

    public function testFactoryMissingCredentialsIsAuthFailed(): void
    {
        try {
            ClientFactory::create('zrexpress', ['apiKey' => 'k']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
        }
    }
}
