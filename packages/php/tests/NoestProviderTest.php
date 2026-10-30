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
use DzDelivery\Support\StatusMapper;
use PHPUnit\Framework\Attributes\DataProvider;

final class NoestProviderTest extends TestCase
{
    private const COMMUNES = [
        ['id' => 571, 'nom' => 'Bab Ezzouar', 'wilaya_id' => 16, 'code_postal' => '16018', 'is_active' => 1],
    ];

    private const INPUT = [
        'recipientName' => 'Test', 'phone' => '0550123456', 'address' => 'x',
        'wilayaId' => 16, 'communeName' => 'Bab Ezzouar', 'productName' => 'Mug', 'price' => 1000,
    ];

    /** @return iterable<string, array{string, string}> every `<method>/<case>` under docs/fixtures/noest */
    public static function fixtureCases(): iterable
    {
        foreach (glob(self::fixturesDir() . '/noest/*/*.expected.json') ?: [] as $file) {
            $method = basename(dirname($file));
            $case = basename($file, '.expected.json');
            yield "$method/$case" => [$method, $case];
        }
    }

    #[DataProvider('fixtureCases')]
    public function testSharedFixture(string $method, string $case): void
    {
        $base = "noest/$method/$case";
        $native = is_file(self::fixturesDir() . "/$base.native.json") ? self::nativeResponses("$base.native.json") : [];
        $input = is_file(self::fixturesDir() . "/$base.input.json") ? self::fixture("$base.input.json") : [];
        $config = is_file(self::fixturesDir() . "/$base.config.json") ? self::fixture("$base.config.json") : [];
        $expected = self::fixture("$base.expected.json");
        $client = $this->client('noest', $native, $config);

        $result = null;
        $error = null;
        try {
            $result = self::call($client, $method, $input);
        } catch (ShippingError $e) {
            $error = $e;
        }

        if (is_file(self::fixturesDir() . "/$base.request.json")) {
            $this->assertRequests("$base.request.json");
        } else {
            self::assertCount(0, $this->history);
        }

        if (isset($expected['error'])) {
            self::assertNotNull($error, 'ShippingError expected');
            self::assertSame('noest', $error->provider);
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

    /** @return iterable<string, array{string, string}> */
    public static function statuses(): iterable
    {
        foreach (self::fixture('noest/statuses.json') as $native => $unified) {
            yield (string) $native => [(string) $native, $unified];
        }
    }

    #[DataProvider('statuses')]
    public function testStatusTable(string $native, string $unified): void
    {
        self::assertSame($unified, StatusMapper::noest($native));
        self::assertSame($unified, StatusMapper::map('noest', $native));
    }

    public function testDefaultHostAndBaseUrlOverride(): void
    {
        $wilayas = [['code' => 16, 'nom' => 'Alger', 'is_active' => 1]];
        $this->client('noest', [self::json(200, $wilayas)])->getWilayas();
        self::assertSame('https://app.noest-dz.com/api/public/get/wilayas', (string) $this->history[0]['request']->getUri());

        $this->client('noest', [self::json(200, $wilayas)], ['baseUrl' => 'https://proxy.test/api/public/'])->getWilayas();
        self::assertSame('https://proxy.test/api/public/get/wilayas', (string) $this->history[0]['request']->getUri());
    }

    public function testBearerPrefixInTokenIsStripped(): void
    {
        $this->client('noest', [self::json(200, [])], ['apiToken' => 'Bearer abc'])->getWilayas();
        self::assertSame('Bearer abc', $this->history[0]['request']->getHeaderLine('Authorization'));
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function missingCredentials(): iterable
    {
        yield 'apiToken' => [['apiToken' => ' ', 'userGuid' => 'g']];
        yield 'userGuid' => [['apiToken' => 't', 'userGuid' => '']];
    }

    #[DataProvider('missingCredentials')]
    public function testMissingCredentialsAreAuthFailed(array $options): void
    {
        try {
            ClientFactory::create('noest', $options);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
            self::assertSame('noest', $e->provider);
        }
    }

    public function testOrdersAreNotValidatedByDefault(): void
    {
        $parcel = $this->client('noest', [
            self::json(200, self::COMMUNES),
            self::json(200, ['success' => true, 'tracking' => 'NST-1']),
        ])->createParcel(self::INPUT);

        self::assertSame('pending', $parcel->status);
        self::assertCount(2, $this->history);
    }

    public function testFailedValidationReportsTheCreatedTrackingNumber(): void
    {
        $client = $this->client('noest', [
            self::json(200, self::COMMUNES),
            self::json(200, ['success' => true, 'tracking' => 'NST-1']),
            self::json(200, ['success' => false, 'message' => 'Stock insuffisant']),
        ], ['autoValidate' => true]);

        try {
            $client->createParcel(self::INPUT);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame('NOEST order NST-1 was created but could not be validated: Stock insuffisant', $e->getMessage());
        }
    }

    public function testNonHttpsBaseUrlIsRejected(): void
    {
        foreach (['noest' => ['apiToken' => 't', 'userGuid' => 'g'], 'ecom' => ['apiKey' => 'k', 'apiToken' => 't']] as $name => $options) {
            try {
                ClientFactory::create($name, $options + ['baseUrl' => 'http://proxy.test']);
                self::fail('ShippingError expected');
            } catch (ShippingError $e) {
                self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
                self::assertSame($name, $e->provider);
            }
        }
    }

    public function testShortOrderIdIsRejectedBeforeAnyRequest(): void
    {
        try {
            $this->client('noest', [])->createParcel(['orderId' => 'A12'] + self::INPUT);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertSame('orderId', $e->details[0]['field'] ?? null);
        }
        self::assertCount(0, $this->history);
    }

    public function testUnknownPartnerIsAuthFailedEvenWithoutRaw(): void
    {
        try {
            $this->client('noest', [self::json(404, ['success' => false, 'message' => 'Partenaire introuvable'])], ['includeRaw' => false])->getWilayas();
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
            self::assertNull($e->raw);
        }
    }

    public function testRefusedCancellationKeepsBusinessCodes(): void
    {
        try {
            $this->client('noest', [self::json(200, ['success' => false, 'errors' => ['account_suspended' => 'Compte suspendu']])])->cancelParcel('NST-1');
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
        }
    }

    public function testIncludeRawFalseOmitsRaw(): void
    {
        $desks = ['16B' => ['code' => '16B', 'name' => 'Alger', 'commune' => 'Bab Azzouar', 'phones' => ['0' => '0550000000']]];
        $result = $this->client('noest', [self::json(200, $desks)], ['includeRaw' => false])->getStopDesks(['wilayaId' => 16]);

        self::assertCount(1, $result);
        self::assertNull($result[0]->raw);
        self::assertSame(['id' => '16B', 'name' => 'Alger', 'wilayaId' => '16', 'phone' => '0550000000'], self::stopDeskToArray($result[0]));
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
            'listParcels' => $client->listParcels($input),
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
