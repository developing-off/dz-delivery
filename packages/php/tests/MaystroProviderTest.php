<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelListPage;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\TrackResult;
use DzDelivery\Providers\MaystroProvider;
use DzDelivery\Support\StatusMapper;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\Attributes\DataProvider;

final class MaystroProviderTest extends TestCase
{
    /** @return iterable<string, array{string, string}> every `<method>/<case>` under docs/fixtures/maystro */
    public static function fixtureCases(): iterable
    {
        foreach (glob(self::fixturesDir() . '/maystro/*/*.expected.json') ?: [] as $file) {
            $method = basename(dirname($file));
            $case = basename($file, '.expected.json');
            yield "$method/$case" => [$method, $case];
        }
    }

    #[DataProvider('fixtureCases')]
    public function testSharedFixture(string $method, string $case): void
    {
        $base = "maystro/$method/$case";
        $native = is_file(self::fixturesDir() . "/$base.native.json") ? self::nativeResponses("$base.native.json") : [];
        $input = is_file(self::fixturesDir() . "/$base.input.json") ? self::fixture("$base.input.json") : [];
        $expected = self::fixture("$base.expected.json");
        $client = $this->client('maystro', $native);

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

    public function testOrdersAndHistoryUseTheDocumentedHosts(): void
    {
        $id = '1394335a-4470-407c-a464-d90932de5510';
        $client = $this->client('maystro', [
            self::json(200, ['id' => $id, 'display_id' => '172316976800001', 'status' => 4]),
            self::json(200, [['status' => 4, 'created_at' => '2026-10-20T09:12:13+01:00', 'comment' => null]]),
            self::json(200, ['order_id' => $id, 'new_status' => 50, 'old_status' => 4]),
        ]);
        $client->track($id);
        $client->cancelParcel($id);

        self::assertSame("https://backend.maystro-delivery.com/api/stores/orders/$id/", (string) $this->history[0]['request']->getUri());
        self::assertSame("https://b.maystro-delivery.com/api/stores/history_order/$id", (string) $this->history[1]['request']->getUri());
        self::assertSame("https://backend.maystro-delivery.com/api/shared/status/$id/", (string) $this->history[2]['request']->getUri());
    }

    /** Shapes seen live: a label page embeds its barcode image; "no order found" is one blank page. */
    private static function labelPdf(int $pages): string
    {
        $body = '';
        for ($i = 0; $i < $pages; $i++) {
            $body .= ($i + 3) . " 0 obj <</Type /Page /Parent 2 0 R>> endobj\n<</Subtype /Image>>\n";
        }

        return "%PDF-1.4\n{$body}2 0 obj <</Type /Pages /Count $pages>> endobj\n%%EOF";
    }

    private function maystro(array $responses): MaystroProvider
    {
        $client = $this->client('maystro', $responses);
        self::assertInstanceOf(MaystroProvider::class, $client);

        return $client;
    }

    public function testGetLabelsPostsTrackingNumbersAndReturnsThePdf(): void
    {
        $labels = $this->maystro([new Response(200, ['Content-Type' => 'application/pdf'], self::labelPdf(2))])
            ->getLabels(['172316976800001', ' 172316976800002 ', '172316976800001']);

        $request = $this->history[0]['request'];
        self::assertSame('POST', $request->getMethod());
        self::assertSame('https://backend.maystro-delivery.com/api/delivery/starter/starter_bordureau/', (string) $request->getUri());
        self::assertSame(['orders_ids' => ['172316976800001', '172316976800002']], json_decode((string) $request->getBody(), true));
        self::assertSame('*/*', $request->getHeaderLine('Accept')); // `application/pdf` gets HTTP 406 live
        self::assertSame('application/pdf', $labels->contentType);
        self::assertSame(2, $labels->labelCount);
        self::assertSame(self::labelPdf(2), $labels->data);
    }

    public function testGetLabelsPostsOrderUuidsToTheV2Endpoint(): void
    {
        $id = '1394335a-4470-407c-a464-d90932de5510';
        $labels = $this->maystro([new Response(200, [], self::labelPdf(1))])->getLabels([$id]);

        self::assertSame('/api/delivery/starter/v2/starter_bordureau/', $this->history[0]['request']->getUri()->getPath());
        self::assertSame(['orders_ids' => [$id]], json_decode((string) $this->history[0]['request']->getBody(), true));
        self::assertSame(1, $labels->labelCount);
    }

    public function testGetLabelsTurnsUuidsIntoTrackingNumbersWhenReferencesAreMixed(): void
    {
        $id = '1394335a-4470-407c-a464-d90932de5510';
        $this->maystro([
            self::json(200, ['id' => $id, 'display_id' => '172316976800001', 'status' => 4]),
            new Response(200, [], self::labelPdf(2)),
        ])->getLabels([$id, '172316976800002']);

        self::assertSame("/api/stores/orders/$id/", $this->history[0]['request']->getUri()->getPath());
        self::assertSame('/api/delivery/starter/starter_bordureau/', $this->history[1]['request']->getUri()->getPath());
        self::assertSame(['orders_ids' => ['172316976800001', '172316976800002']], json_decode((string) $this->history[1]['request']->getBody(), true));
    }

    public function testGetLabelsDropsAnUnknownUuidFromAMixedRequest(): void
    {
        $labels = $this->maystro([
            self::json(404, ['detail' => 'Pas trouvé.', 'status_code' => 404]),
            new Response(200, [], self::labelPdf(1)),
        ])->getLabels(['1394335a-4470-407c-a464-d90932de5510', '172316976800002']);

        self::assertSame(['orders_ids' => ['172316976800002']], json_decode((string) $this->history[1]['request']->getBody(), true));
        self::assertSame(1, $labels->labelCount);
    }

    public function testGetLabelsThrowsNotFoundOnTheBlankPage(): void
    {
        $blank = "%PDF-1.4\n3 0 obj <</Type /Page /Parent 2 0 R>> endobj\n2 0 obj <</Type /Pages /Count 1>> endobj\n%%EOF";
        try {
            $this->maystro([new Response(200, [], $blank)])->getLabels(['111']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::NOT_FOUND, $e->code);
            self::assertSame('maystro', $e->provider);
        }
    }

    public function testGetLabelsRejectsAnEmptyListWithoutCallingMaystro(): void
    {
        try {
            $this->maystro([])->getLabels([' ']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertCount(0, $this->history);
        }
    }

    public function testGetLabelsMapsAJsonErrorBody(): void
    {
        try {
            $this->maystro([self::json(401, ['detail' => 'Token non valide.', 'status_code' => 401])])->getLabels(['1']);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::AUTH_FAILED, $e->code);
            self::assertSame('Token non valide.', $e->getMessage());
        }
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
