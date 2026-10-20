<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\ClientFactory;
use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\TrackResult;
use DzDelivery\Providers\EcotrackProvider;
use DzDelivery\Support\StatusMapper;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use PHPUnit\Framework\Attributes\DataProvider;

final class EcotrackProviderTest extends TestCase
{
    private const COMMUNES = [
        '0' => ['nom' => 'Bab Ezzouar', 'wilaya_id' => 16, 'code_postal' => '1625', 'has_stop_desk' => 1],
    ];

    private const INPUT = [
        'recipientName' => 'Test', 'phone' => '0550123456', 'address' => 'x',
        'wilayaId' => 16, 'communeName' => 'Bab Ezzouar', 'productName' => 'Mug', 'price' => 1000,
    ];

    /** @return iterable<string, array{string, string}> every `<method>/<case>` under docs/fixtures/ecotrack */
    public static function fixtureCases(): iterable
    {
        foreach (glob(self::FIXTURES . '/ecotrack/*/*.expected.json') ?: [] as $file) {
            $method = basename(dirname($file));
            $case = basename($file, '.expected.json');
            yield "$method/$case" => [$method, $case];
        }
    }

    #[DataProvider('fixtureCases')]
    public function testSharedFixture(string $method, string $case): void
    {
        $base = "ecotrack/$method/$case";
        $native = is_file(self::FIXTURES . "/$base.native.json") ? self::nativeResponses("$base.native.json") : [];
        $input = is_file(self::FIXTURES . "/$base.input.json") ? self::fixture("$base.input.json") : [];
        $config = is_file(self::FIXTURES . "/$base.config.json") ? self::fixture("$base.config.json") : [];
        $expected = self::fixture("$base.expected.json");
        $client = $this->client('ecotrack', $native, $config);

        $result = null;
        $error = null;
        try {
            $result = self::call($client, $method, $input);
        } catch (ShippingError $e) {
            $error = $e;
        }

        if (is_file(self::FIXTURES . "/$base.request.json")) {
            $this->assertRequests("$base.request.json");
        } else {
            self::assertCount(0, $this->history);
        }

        if (isset($expected['error'])) {
            self::assertNotNull($error, 'ShippingError expected');
            self::assertSame('ecotrack', $error->provider);
            foreach ($expected['error'] as $key => $value) {
                $actual = match ($key) {
                    'message' => $error->getMessage(),
                    default => $error->{$key},
                };
                self::assertSame($value, $actual, "error.$key");
            }

            return;
        }

        if ($error !== null) {
            throw $error;
        }
        if ($expected['result'] === null) {
            self::assertNull($result);

            return;
        }
        self::assertSame($expected['result'], self::toArray($result));
        if ($result instanceof Parcel || $result instanceof FeeQuote) {
            self::assertNotNull($result->raw);
        }
    }

    public function testCourierShortcutResolvesTheTenantHost(): void
    {
        $client = $this->clientWith(['token' => 't', 'courier' => 'DHD'], [self::json(200, [['wilaya_id' => 16, 'wilaya_name' => 'Alger']])]);
        $client->getWilayas();

        self::assertSame('https://platform.dhd-dz.com/api/v1/get/wilayas', (string) $this->history[0]['request']->getUri());
        self::assertSame('Bearer t', $this->history[0]['request']->getHeaderLine('Authorization'));
        self::assertSame('https://app.conexlog-dz.com', EcotrackProvider::resolveBaseUrl(null, 'conexlog'));
    }

    public function testBaseUrlGetsApiPrefixOnce(): void
    {
        self::assertSame('https://test.ecotrack.dz', EcotrackProvider::resolveBaseUrl('https://test.ecotrack.dz/', null));
        self::assertSame('https://test.ecotrack.dz', EcotrackProvider::resolveBaseUrl('https://Test.ecotrack.dz/api/v1/', null));
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function invalidTenants(): iterable
    {
        yield 'neither baseUrl nor courier' => [[]];
        yield 'both baseUrl and courier' => [['baseUrl' => 'https://test.ecotrack.dz', 'courier' => 'dhd']];
        yield 'unknown courier' => [['courier' => 'nope']];
        yield 'http baseUrl' => [['baseUrl' => 'http://test.ecotrack.dz']];
        yield 'malformed baseUrl' => [['baseUrl' => 'test.ecotrack.dz']];
    }

    /** @param array<string, mixed> $options */
    #[DataProvider('invalidTenants')]
    public function testInvalidTenantIsValidationError(array $options): void
    {
        try {
            ClientFactory::create('ecotrack', ['token' => 't'] + $options);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertSame('ecotrack', $e->provider);
        }
    }

    public function testMissingTokenIsAuthFailed(): void
    {
        try {
            ClientFactory::create('ecotrack', ['token' => ' ', 'courier' => 'dhd']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
        }
    }

    public function testStatusMapperUsesStableKeysOnly(): void
    {
        self::assertSame('returned', StatusMapper::ecotrack('Return_received'));
        self::assertSame('cancelled', StatusMapper::ecotrack('annule'));
        self::assertSame('unknown', StatusMapper::ecotrack('Prêt à expédier'));
        self::assertSame('unknown', StatusMapper::ecotrack(null));
    }

    public function testFailedValidationReportsTheCreatedTrackingNumber(): void
    {
        $client = $this->clientWith(['token' => 't', 'courier' => 'dhd', 'autoValidate' => true], [
            self::json(200, self::COMMUNES),
            self::json(200, ['success' => true, 'tracking' => 'ECTEST1']),
            self::json(429, ['message' => 'Too Many Attempts.'], ['Retry-After' => '30']),
        ]);

        try {
            $client->createParcel(self::INPUT);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::RATE_LIMITED, $e->code);
            self::assertSame(429, $e->httpStatus);
            self::assertSame(30, $e->retryAfter);
            self::assertSame('Ecotrack order ECTEST1 was created but could not be validated: Too Many Attempts.', $e->getMessage());
        }
    }

    public function testOrdersAreNotValidatedByDefault(): void
    {
        $client = $this->clientWith(['token' => 't', 'courier' => 'dhd'], [
            self::json(200, self::COMMUNES),
            self::json(200, ['success' => true, 'tracking' => 'ECTEST1']),
        ]);

        self::assertSame('pending', $client->createParcel(self::INPUT)->status);
        self::assertCount(2, $this->history);
    }

    /**
     * @param array<string, mixed> $options
     * @param list<\GuzzleHttp\Psr7\Response> $responses
     */
    private function clientWith(array $options, array $responses): ShippingProviderInterface
    {
        $this->history = [];
        $this->mock = new MockHandler($responses);
        $stack = HandlerStack::create($this->mock);
        $stack->push(Middleware::history($this->history));

        return ClientFactory::create('ecotrack', $options + ['handler' => $stack]);
    }

    /** @param array<string, mixed> $input */
    private static function call(ShippingProviderInterface $client, string $method, array $input): mixed
    {
        return match ($method) {
            'createParcel' => $client->createParcel($input),
            'track' => $client->track($input['trackingNumber']),
            'getFees' => $client->getFees($input),
            'getWilayas' => $client->getWilayas(),
            'getCommunes' => $client->getCommunes($input['wilayaId']),
            'getStopDesks' => $client->getStopDesks($input),
            'cancelParcel' => $client->cancelParcel($input['trackingNumberOrId']),
        };
    }

    private static function toArray(mixed $result): mixed
    {
        $withoutNulls = static fn (array $a) => array_filter($a, static fn ($v) => $v !== null);

        return match (true) {
            $result instanceof Parcel => self::parcelToArray($result),
            $result instanceof TrackResult => self::trackToArray($result),
            $result instanceof FeeQuote => $withoutNulls([
                'deliveryFee' => $result->deliveryFee,
                'returnFee' => $result->returnFee,
                'stopDeskFee' => $result->stopDeskFee,
                'currency' => $result->currency,
            ]),
            is_array($result) => array_map(
                static fn (Location|StopDesk $l) => $withoutNulls($l instanceof StopDesk ? self::stopDeskToArray($l) : self::locationToArray($l)),
                $result,
            ),
            default => $result,
        };
    }
}
