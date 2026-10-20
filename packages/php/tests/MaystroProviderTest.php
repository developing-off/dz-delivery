<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\StatusMapper;
use PHPUnit\Framework\Attributes\DataProvider;

final class MaystroProviderTest extends TestCase
{
    /** @return iterable<string, array{string, string}> every `<method>/<case>` under docs/fixtures/maystro */
    public static function fixtureCases(): iterable
    {
        foreach (glob(self::FIXTURES . '/maystro/*/*.expected.json') ?: [] as $file) {
            $method = basename(dirname($file));
            $case = basename($file, '.expected.json');
            yield "$method/$case" => [$method, $case];
        }
    }

    #[DataProvider('fixtureCases')]
    public function testSharedFixture(string $method, string $case): void
    {
        $base = "maystro/$method/$case";
        $native = is_file(self::FIXTURES . "/$base.native.json") ? self::nativeResponses("$base.native.json") : [];
        $input = is_file(self::FIXTURES . "/$base.input.json") ? self::fixture("$base.input.json") : [];
        $expected = self::fixture("$base.expected.json");
        $client = $this->client('maystro', $native);

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
            self::assertSame('maystro', $error->provider);
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

    public function testStatusMapperAcceptsIntegerCodes(): void
    {
        self::assertSame('delivered', StatusMapper::maystro(41));
        self::assertSame('pending', StatusMapper::maystro(4));
        self::assertSame('unknown', StatusMapper::maystro(7));
        self::assertSame('unknown', StatusMapper::maystro(null));
    }

    public function testTokenPrefixIsNotDoubled(): void
    {
        $client = $this->client('maystro', [self::json(200, [[16, 'Alger']])], ['apiToken' => 'Token abc']);
        $client->getWilayas();

        self::assertSame('Token abc', $this->history[0]['request']->getHeaderLine('Authorization'));
    }

    public function testMissingTokenIsAuthFailed(): void
    {
        try {
            $this->client('maystro', [], ['apiToken' => ' ']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
        }
    }

    public function testOrderErrorCodesAreReadFromA400Body(): void
    {
        $client = $this->client('maystro', [
            self::json(200, [[16, 'Alger']]),
            self::json(200, [['id' => 554, 'wilaya' => 16, 'name' => 'Alger Centre']]),
            self::json(400, [['success' => false, 'errors' => [10]]]),
        ]);

        try {
            $client->createParcel([
                'recipientName' => 'Test', 'phone' => '0550123456', 'address' => 'x',
                'wilayaId' => 16, 'communeId' => 554, 'productName' => 'Mug', 'price' => 1000,
            ]);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertSame(400, $e->httpStatus);
            self::assertSame('Order price is not valid or it was not defined', $e->getMessage());
            self::assertSame([['field' => 'price', 'message' => 'Order price is not valid or it was not defined', 'code' => '10']], $e->details);
        }
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
