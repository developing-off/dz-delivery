<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\ClientFactory;
use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelListPage;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\StatusMapper;
use PHPUnit\Framework\Attributes\DataProvider;

final class EcomProviderTest extends TestCase
{
    /** @return iterable<string, array{string, string}> every `<method>/<case>` under docs/fixtures/ecom */
    public static function fixtureCases(): iterable
    {
        foreach (glob(self::fixturesDir() . '/ecom/*/*.expected.json') ?: [] as $file) {
            $method = basename(dirname($file));
            $case = basename($file, '.expected.json');
            yield "$method/$case" => [$method, $case];
        }
    }

    #[DataProvider('fixtureCases')]
    public function testSharedFixture(string $method, string $case): void
    {
        $base = "ecom/$method/$case";
        $native = is_file(self::fixturesDir() . "/$base.native.json") ? self::nativeResponses("$base.native.json") : [];
        $input = is_file(self::fixturesDir() . "/$base.input.json") ? self::fixture("$base.input.json") : [];
        $config = is_file(self::fixturesDir() . "/$base.config.json") ? self::fixture("$base.config.json") : [];
        $expected = self::fixture("$base.expected.json");
        $client = $this->client('ecom', $native, $config);

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
            self::assertSame('ecom', $error->provider);
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
        foreach (self::fixture('ecom/statuses.json') as $native => $unified) {
            yield (string) $native => [(string) $native, $unified];
        }
    }

    #[DataProvider('statuses')]
    public function testStatusTable(string $native, string $unified): void
    {
        self::assertSame($unified, StatusMapper::ecom($native));
        self::assertSame($unified, StatusMapper::map('ecom', $native));
    }

    public function testDefaultHostAndAuthHeaders(): void
    {
        $this->client('ecom', [self::json(200, [])])->getWilayas();
        $request = $this->history[0]['request'];
        self::assertSame('https://ecom-dz.com/api_v2/wilayas', (string) $request->getUri());
        self::assertSame('test-api-key', $request->getHeaderLine('X-API-Key'));
        self::assertSame('test-api-token', $request->getHeaderLine('X-API-Token'));
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function missingCredentials(): iterable
    {
        yield 'apiKey' => [['apiKey' => ' ', 'apiToken' => 't']];
        yield 'apiToken' => [['apiKey' => 'k', 'apiToken' => '']];
    }

    #[DataProvider('missingCredentials')]
    public function testMissingCredentialsAreAuthFailed(array $options): void
    {
        try {
            ClientFactory::create('ecom', $options);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
            self::assertSame('ecom', $e->provider);
        }
    }

    public function testAllPagesFollowsUntilTheLastPage(): void
    {
        $item = static fn (string $t) => ['tracking' => $t, 'situation' => 'EnCours', 'etat_logistique' => 'Au Bureau'];
        $result = $this->client('ecom', [
            self::json(200, ['total' => 3, 'page' => 1, 'limit' => 2, 'total_pages' => 2, 'items' => [$item('A'), $item('B')]]),
            self::json(200, ['total' => null, 'page' => 2, 'limit' => 2, 'total_pages' => null, 'items' => [$item('C')]]),
        ])->listParcels(['pageSize' => 2, 'allPages' => true]);

        self::assertSame(['A', 'B', 'C'], array_map(static fn (Parcel $p) => $p->trackingNumber, $result->parcels));
        self::assertSame(3, $result->totalCount);
        self::assertFalse($result->hasNext);
        self::assertCount(2, $this->history);
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
            $result instanceof ParcelListPage => [
                'parcels' => array_map(static fn (Parcel $p) => self::parcelToArray($p), $result->parcels),
                'page' => $result->page,
                'pageSize' => $result->pageSize,
                'totalCount' => $result->totalCount,
                'hasNext' => $result->hasNext,
            ],
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
