<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\Errors\ShippingError;

final class YalidineProviderTest extends TestCase
{
    private const WILAYAS = [
        'has_more' => false,
        'data' => [
            ['id' => 5, 'name' => 'Batna', 'zone' => 2, 'is_deliverable' => 1],
            ['id' => 16, 'name' => 'Alger', 'zone' => 1, 'is_deliverable' => 1],
            ['id' => 33, 'name' => 'Illizi', 'zone' => 5, 'is_deliverable' => 0],
        ],
    ];

    private const COMMUNES_16 = [
        'has_more' => false,
        'data' => [
            ['id' => 1630, 'name' => 'Bab Ezzouar', 'wilaya_id' => 16, 'is_deliverable' => 1, 'has_stop_desk' => 1],
            ['id' => 1631, 'name' => 'Hydra', 'wilaya_id' => 16, 'is_deliverable' => 1, 'has_stop_desk' => 0],
        ],
    ];

    public function testTrackReturnsParcelAndSortedEvents(): void
    {
        $client = $this->client('yalidine', self::nativeResponses('yalidine/track/out-for-delivery.native.json'));

        $result = $client->track('yal-ABC123');

        self::assertSame(self::fixture('yalidine/track/out-for-delivery.expected.json')['result'], self::trackToArray($result));
        $this->assertRequests('yalidine/track/out-for-delivery.request.json');
    }

    public function testTrackUnknownParcelThrowsNotFound(): void
    {
        $client = $this->client('yalidine', [self::json(200, ['has_more' => false, 'total_data' => 0, 'data' => []])]);

        $this->expectExceptionObject(new ShippingError(ShippingError::NOT_FOUND, 'Parcel not found: yal-NOPE'));
        $client->track('yal-NOPE');
    }

    public function testCreateParcelResolvesIdsToNamesAndPostsArray(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, self::COMMUNES_16),
            self::json(200, ['ORD-2001' => [
                'success' => true, 'order_id' => 'ORD-2001', 'tracking' => 'yal-ABC123',
                'import_id' => 1, 'label' => 'https://yalidine.app/label', 'message' => '',
            ]]),
        ]);

        $parcel = $client->createParcel([
            'recipientName' => 'Client Test Junior',
            'phone' => '+213 550 12 34 56',
            'phone2' => '0770000000',
            'address' => '12 rue des Tests',
            'wilayaId' => 16,
            'communeId' => 1630,
            'productList' => [['name' => 'Mug', 'quantity' => 2], ['name' => 'Tee']],
            'price' => 3200,
            'orderId' => 'ORD-2001',
        ]);

        self::assertSame(['id' => 'yal-ABC123', 'trackingNumber' => 'yal-ABC123', 'status' => 'pending', 'provider' => 'yalidine'], self::parcelToArray($parcel));
        $body = json_decode((string) $this->history[2]['request']->getBody(), true);
        self::assertSame('/v1/parcels/', $this->history[2]['request']->getUri()->getPath());
        self::assertSubset([[
            'order_id' => 'ORD-2001',
            'from_wilaya_name' => 'Batna',
            'firstname' => 'Client',
            'familyname' => 'Test Junior',
            'contact_phone' => '0550123456,0770000000',
            'to_wilaya_name' => 'Alger',
            'to_commune_name' => 'Bab Ezzouar',
            'product_list' => 'Mug x2, Tee',
            'price' => 3200,
            'freeshipping' => true,
            'is_stopdesk' => false,
            'length' => 0,
            'width' => 0,
            'height' => 0,
            'weight' => 0,
        ]], $body);
    }

    public function testCreateParcelRejectedByYalidineIsValidationError(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, self::COMMUNES_16),
            self::json(200, ['X' => ['success' => false, 'order_id' => 'X', 'tracking' => null, 'message' => 'contact_phone is invalid']]),
        ]);

        try {
            $client->createParcel([
                'recipientName' => 'Client', 'phone' => '0550123456', 'address' => 'x',
                'wilayaName' => 'ALGER', 'communeName' => 'hydra', 'productName' => 'Tee', 'price' => 100, 'orderId' => 'X',
            ]);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertSame('contact_phone is invalid', $e->getMessage());
        }
    }

    public function testCreateParcelStopDeskUsesCenterCommuneAndWilayaNames(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, self::COMMUNES_16),
            self::json(200, [
                'has_more' => false,
                'data' => [[
                    'center_id' => 163001,
                    'name' => 'Centre Bab Ezzouar',
                    'commune_id' => 1630,
                    'commune_name' => 'Bab Ezzouar',
                    'wilaya_id' => 16,
                    'wilaya_name' => 'Alger',
                ]],
            ]),
            self::json(200, ['O1' => [
                'success' => true, 'order_id' => 'O1', 'tracking' => 'yal-1',
                'import_id' => 1, 'label' => '', 'message' => '',
            ]]),
        ]);

        $client->createParcel([
            'recipientName' => 'Client',
            'phone' => '0550123456',
            'address' => 'x',
            'wilayaId' => 16,
            'communeId' => 1631,
            'productName' => 'Tee',
            'price' => 100,
            'isStopDesk' => true,
            'stopDeskId' => '163001',
            'orderId' => 'O1',
        ]);

        $body = json_decode((string) $this->history[3]['request']->getBody(), true);
        self::assertSubset([[
            'is_stopdesk' => true,
            'stopdesk_id' => 163001,
            'to_commune_name' => 'Bab Ezzouar',
            'to_wilaya_name' => 'Alger',
        ]], $body);
    }

    public function testGetFeesUsesOriginAndCommune(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, [
                'from_wilaya_name' => 'Batna', 'to_wilaya_name' => 'Alger', 'zone' => 2,
                'retour_fee' => 250, 'cod_percentage' => 1, 'insurance_percentage' => 1, 'oversize_fee' => 50,
                'per_commune' => [
                    '1630' => ['commune_id' => 1630, 'commune_name' => 'Bab Ezzouar', 'express_home' => 600, 'express_desk' => 400],
                    '1631' => ['commune_id' => 1631, 'commune_name' => 'Hydra', 'express_home' => 650, 'express_desk' => null],
                ],
            ]),
        ]);

        $quote = $client->getFees(['toWilayaId' => 16, 'toCommuneId' => 1630, 'weight' => 6.5]);

        // (6.5 − 5) × 50 = 75 DA overweight fee.
        self::assertSame(675, $quote->deliveryFee);
        self::assertSame(475, $quote->stopDeskFee);
        self::assertSame(250, $quote->returnFee);
        parse_str($this->history[1]['request']->getUri()->getQuery(), $query);
        self::assertSame(['from_wilaya_id' => '5', 'to_wilaya_id' => '16'], $query);
    }

    public function testGetFeesAcceptsWilayaNames(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, ['per_commune' => ['1630' => ['commune_id' => 1630, 'express_home' => 600]]]),
        ]);

        $quote = $client->getFees(['toWilayaId' => 'alger', 'fromWilayaId' => 'Batna']);

        self::assertSame(600, $quote->deliveryFee);
        parse_str($this->history[1]['request']->getUri()->getQuery(), $query);
        self::assertSame(['from_wilaya_id' => '5', 'to_wilaya_id' => '16'], $query);
    }

    public function testGetFeesUsesVolumetricWeightWhenHigher(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, [
                'retour_fee' => 250, 'oversize_fee' => 50,
                'per_commune' => ['1630' => ['commune_id' => 1630, 'express_home' => 600, 'express_desk' => 400]],
            ]),
        ]);

        // 50 × 40 × 30 × 0.0002 = 12 kg billable → (12 − 5) × 50 = 350 DA.
        $quote = $client->getFees(['toWilayaId' => 16, 'toCommuneId' => 1630, 'weight' => 2, 'length' => 50, 'width' => 40, 'height' => 30]);

        self::assertSame(950, $quote->deliveryFee);
        self::assertSame(750, $quote->stopDeskFee);
    }

    public function testGetWilayasSkipsUndeliverableAndGetCommunes(): void
    {
        $client = $this->client('yalidine', [self::json(200, self::WILAYAS), self::json(200, self::COMMUNES_16)]);

        $wilayas = $client->getWilayas();
        $communes = $client->getCommunes('16');

        self::assertSame(['5', '16'], array_map(static fn ($w) => $w->id, $wilayas));
        self::assertSame('16', $wilayas[1]->code);
        self::assertSame(['id' => '1630', 'name' => 'Bab Ezzouar', 'parentId' => '16', 'code' => null], self::locationToArray($communes[0]));
    }

    public function testGetStopDesksListsCentersOfACommune(): void
    {
        $client = $this->client('yalidine', self::nativeResponses('yalidine/getStopDesks/by-commune.native.json'));

        $desks = $client->getStopDesks(self::fixture('yalidine/getStopDesks/by-commune.input.json'));

        self::assertSame(
            self::fixture('yalidine/getStopDesks/by-commune.expected.json')['result'],
            array_map(static fn ($d) => array_filter(self::stopDeskToArray($d), static fn ($v) => $v !== null), $desks),
        );
        $this->assertRequests('yalidine/getStopDesks/by-commune.request.json');
    }

    public function testCancelParcel(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, [['tracking' => 'yal-ABC123', 'deleted' => true]]),
            self::json(200, [['tracking' => 'yal-ABC124', 'deleted' => false]]),
        ]);

        $client->cancelParcel('yal-ABC123');
        self::assertSame('DELETE', $this->history[0]['request']->getMethod());
        self::assertSame('/v1/parcels/yal-ABC123', $this->history[0]['request']->getUri()->getPath());

        $this->expectException(ShippingError::class);
        $client->cancelParcel('yal-ABC124');
    }

    public function testRateLimitIsMapped(): void
    {
        $client = $this->client('yalidine', [self::json(429, ['error' => ['code' => 429, 'message' => 'Too many requests']])]);

        try {
            $client->track('yal-1');
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::RATE_LIMITED, $e->code);
            self::assertSame('Too many requests', $e->getMessage());
            self::assertNull($e->retryAfter);
        }
    }

    public function testRateLimitExposesRetryAfter(): void
    {
        $client = $this->client('yalidine', [self::json(429, ['error' => ['message' => 'Too many']], ['Retry-After' => '7'])]);

        try {
            $client->getWilayas();
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::RATE_LIMITED, $e->code);
            self::assertSame(7, $e->retryAfter);
        }
    }

    public function testListsRequestTheLargestPageSize(): void
    {
        $client = $this->client('yalidine', [self::json(200, self::WILAYAS)]);

        $client->getWilayas();

        parse_str($this->history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame(['page' => '1', 'page_size' => '1000'], $query);
    }

    public function testHealthCheckProbesWilayasAndReturnsLatency(): void
    {
        $client = $this->client('yalidine', [self::json(200, self::WILAYAS)]);

        $health = $client->healthCheck();

        self::assertTrue($health->ok);
        self::assertSame('yalidine', $health->provider);
        self::assertGreaterThanOrEqual(0, $health->latencyMs);
        self::assertCount(1, $this->history);
    }

    public function testHealthCheckBypassesWilayasCache(): void
    {
        $client = $this->client('yalidine', [
            self::json(200, self::WILAYAS),
            self::json(200, self::WILAYAS),
        ]);

        $client->getWilayas();
        $client->healthCheck();

        self::assertCount(2, $this->history);
    }
}
