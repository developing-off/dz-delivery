<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\Errors\ShippingError;
use DzDelivery\Models\ParcelInput;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Psr7\Request;

final class ZRExpressProviderTest extends TestCase
{
    private const WILAYA_16 = '00000000-0000-4000-8000-000000000016';
    private const PARCEL_ID = '8c1a4c53-0000-4000-8000-00000000a001';

    public function testCreateParcelResolvesNamesNormalizesPhoneAndFetchesTrackingNumber(): void
    {
        $client = $this->client('zrexpress', self::nativeResponses('zrexpress/createParcel/home-delivery.native.json'));

        $parcel = $client->createParcel(self::fixture('zrexpress/createParcel/home-delivery.input.json'));

        self::assertSame(self::fixture('zrexpress/createParcel/home-delivery.expected.json')['result'], self::parcelToArray($parcel));
        self::assertIsArray($parcel->raw);
        $this->assertRequests('zrexpress/createParcel/home-delivery.request.json');

        $body = json_decode((string) $this->history[2]['request']->getBody(), true);
        self::assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $body['customer']['customerId']);
        self::assertArrayNotHasKey('hubId', $body);
    }

    public function testCreateParcelStopDeskWithIdsSkipsTerritoryLookup(): void
    {
        $client = $this->client('zrexpress', [
            self::json(201, ['id' => self::PARCEL_ID]),
            self::json(200, ['id' => self::PARCEL_ID, 'trackingNumber' => 'DZ-AL-1', 'state' => ['name' => 'ReadyToDispatch']]),
        ]);

        $parcel = $client->createParcel(new ParcelInput(
            recipientName: 'Client Test',
            phone: '213661000000',
            address: 'Stop desk',
            price: 1000,
            wilayaId: self::WILAYA_16,
            communeId: '00000000-0000-4000-8000-000000016042',
            productList: [['name' => 'Mug', 'quantity' => 2, 'unitPrice' => 500, 'sku' => 'MUG-1']],
            phone2: '0770 00 00 00',
            length: 10,
            isStopDesk: true,
            stopDeskId: 'hub-1',
        ));

        self::assertSame('created', $parcel->status);
        self::assertCount(2, $this->history);
        $body = json_decode((string) $this->history[0]['request']->getBody(), true);
        self::assertSame('pickup-point', $body['deliveryType']);
        self::assertSame('hub-1', $body['hubId']);
        self::assertSame(['number1' => '+213661000000', 'number2' => '+213770000000'], $body['customer']['phone']);
        self::assertSame('Mug x2', $body['description']);
        self::assertSame(
            ['productName' => 'Mug', 'quantity' => 2, 'unitPrice' => 500, 'productSku' => 'MUG-1', 'stockType' => 'none', 'length' => 10],
            $body['orderedProducts'][0],
        );
    }

    public function testCreateParcelMapsProblemDetailsToShippingError(): void
    {
        $client = $this->client('zrexpress', self::nativeResponses('zrexpress/createParcel/validation-error.native.json'));
        $expected = self::fixture('zrexpress/createParcel/validation-error.expected.json')['error'];

        try {
            $client->createParcel(self::fixture('zrexpress/createParcel/validation-error.input.json'));
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame($expected['code'], $e->code);
            self::assertSame($expected['code'], $e->getCode());
            self::assertSame($expected['httpStatus'], $e->httpStatus);
            self::assertSame($expected['message'], $e->getMessage());
            self::assertSame($expected['details'], $e->details);
            self::assertSame('zrexpress', $e->provider);
            self::assertSame('General.Validation', $e->raw['title']);
        }
    }

    public function testGetStopDesksIsNotSupportedYet(): void
    {
        $client = $this->client('zrexpress', []);

        try {
            $client->getStopDesks(['wilayaId' => 16]);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::NOT_SUPPORTED, $e->code);
            self::assertCount(0, $this->history);
        }
    }

    public function testCreateParcelValidatesBeforeAnyHttpCall(): void
    {
        $client = $this->client('zrexpress', []);

        try {
            $client->createParcel([
                'recipientName' => 'Client Test',
                'phone' => '0550123456',
                'address' => 'x',
                'wilayaId' => 16,
                'wilayaName' => 'Alger',
                'communeName' => 'Bab Ezzouar',
                'productName' => 'T-shirt',
                'price' => 100,
            ]);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::VALIDATION_ERROR, $e->code);
            self::assertSame('wilayaId', $e->details[0]['field']);
        }
        self::assertCount(0, $this->history);
    }

    public function testCreateParcelRejectsInvalidPhone(): void
    {
        $client = $this->client('zrexpress', []);

        $this->expectException(ShippingError::class);
        $this->expectExceptionMessage('Invalid Algerian phone number');
        $client->createParcel([
            'recipientName' => 'Client Test', 'phone' => '12', 'address' => 'x',
            'wilayaId' => self::WILAYA_16, 'communeId' => self::WILAYA_16, 'productName' => 'Tee', 'price' => 100,
        ]);
    }

    public function testCreateParcelUnknownWilayaNameIsNotFound(): void
    {
        $client = $this->client('zrexpress', array_slice(self::nativeResponses('zrexpress/createParcel/home-delivery.native.json'), 0, 1));

        try {
            $client->createParcel([
                'recipientName' => 'Client Test', 'phone' => '0550123456', 'address' => 'x',
                'wilayaName' => 'Atlantis', 'communeName' => 'Nowhere', 'productName' => 'Tee', 'price' => 100,
            ]);
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::NOT_FOUND, $e->code);
        }
    }

    public function testTrackReturnsParcelAndSortedEvents(): void
    {
        $client = $this->client('zrexpress', self::nativeResponses('zrexpress/track/delivered.native.json'));

        $result = $client->track('DZ-AL-20251121-00145');

        self::assertSame(self::fixture('zrexpress/track/delivered.expected.json')['result'], self::trackToArray($result));
        self::assertNotNull($result->events[0]->raw);
        $this->assertRequests('zrexpress/track/delivered.request.json');
    }

    public function testTrackUnknownParcelThrowsNotFound(): void
    {
        $client = $this->client('zrexpress', [
            self::json(404, ['title' => 'Parcel.NotFound', 'status' => 404, 'detail' => 'Parcel was not found']),
        ]);

        try {
            $client->track('DZ-NOPE');
            self::fail('ShippingError expected');
        } catch (ShippingError $e) {
            self::assertSame(ShippingError::NOT_FOUND, $e->code);
            self::assertSame(404, $e->httpStatus);
            self::assertSame('Parcel was not found', $e->getMessage());
        }
    }

    public function testHttpStatusesMapToContractCodes(): void
    {
        foreach ([401 => 'AUTH_FAILED', 403 => 'AUTH_FAILED', 422 => 'VALIDATION_ERROR', 429 => 'RATE_LIMITED', 503 => 'PROVIDER_ERROR', 409 => 'UNKNOWN'] as $status => $code) {
            $client = $this->client('zrexpress', [self::json($status, ['title' => 'x'])]);
            try {
                $client->track('DZ-1');
                self::fail("ShippingError expected for $status");
            } catch (ShippingError $e) {
                self::assertSame($code, $e->code, "HTTP $status");
            }
        }
    }

    public function testNetworkFailureThrowsNetworkError(): void
    {
        $client = $this->client('zrexpress', [
            new ConnectException('Connection refused', new Request('GET', 'https://api.zrexpress.app')),
        ]);

        $this->expectExceptionObject(new ShippingError(ShippingError::NETWORK_ERROR, 'Connection refused'));
        $client->track('DZ-1');
    }

    public function testCancelByTrackingNumberResolvesIdThenDeletes(): void
    {
        $client = $this->client('zrexpress', [
            self::json(200, ['id' => self::PARCEL_ID, 'trackingNumber' => 'DZ-AL-1', 'state' => ['name' => 'commande_recue']]),
            self::json(204),
        ]);

        $client->cancelParcel('DZ-AL-1');

        self::assertSame('GET', $this->history[0]['request']->getMethod());
        self::assertSame('DELETE', $this->history[1]['request']->getMethod());
        self::assertSame('/api/v1/parcels/' . self::PARCEL_ID, $this->history[1]['request']->getUri()->getPath());
    }

    public function testCancelByUuidDeletesDirectly(): void
    {
        $client = $this->client('zrexpress', [self::json(204)]);

        $client->cancelParcel(self::PARCEL_ID);

        self::assertCount(1, $this->history);
        self::assertSame('DELETE', $this->history[0]['request']->getMethod());
    }

    public function testGetFeesResolvesWilayaCodeAndPicksDeliveryType(): void
    {
        $territories = self::nativeResponses('zrexpress/createParcel/home-delivery.native.json')[0];
        $rate = ['toTerritoryId' => self::WILAYA_16, 'deliveryPrices' => [
            ['deliveryType' => 'home', 'price' => 600],
            ['deliveryType' => 'pickup-point', 'price' => 400],
        ]];
        $client = $this->client('zrexpress', [$territories, self::json(200, $rate)]);

        $quote = $client->getFees(['toWilayaId' => 16, 'isStopDesk' => true]);

        self::assertSame(400, $quote->deliveryFee);
        self::assertSame(400, $quote->stopDeskFee);
        self::assertNull($quote->returnFee);
        self::assertSame('DZD', $quote->currency);
        self::assertSame('/api/v1/delivery-pricing/rates/' . self::WILAYA_16, $this->history[1]['request']->getUri()->getPath());
    }

    public function testGetFeesWithoutRateThrowsNotFound(): void
    {
        $client = $this->client('zrexpress', [self::json(200, ['deliveryPrices' => [['deliveryType' => 'home', 'price' => 600]]])]);

        $this->expectExceptionObject(new ShippingError(ShippingError::NOT_FOUND, 'No ZRExpress rate for this destination/delivery type'));
        $client->getFees(['toWilayaId' => self::WILAYA_16, 'isStopDesk' => true]);
    }

    public function testGetWilayasAndCommunesMapTerritoriesAndCache(): void
    {
        $native = self::nativeResponses('zrexpress/createParcel/home-delivery.native.json');
        $client = $this->client('zrexpress', [$native[0], $native[1]]);

        $wilayas = $client->getWilayas();
        $client->getWilayas();
        $communes = $client->getCommunes(16);

        self::assertSame(['id' => self::WILAYA_16, 'name' => 'Alger', 'parentId' => null, 'code' => '16'], self::locationToArray($wilayas[0]));
        self::assertSame(
            ['id' => '00000000-0000-4000-8000-000000016042', 'name' => 'Bab Ezzouar', 'parentId' => self::WILAYA_16, 'code' => '16042'],
            self::locationToArray($communes[0]),
        );
        self::assertCount(2, $this->history);
    }

    public function testIncludeRawFalseOmitsRaw(): void
    {
        $client = $this->client('zrexpress', self::nativeResponses('zrexpress/track/delivered.native.json'), ['includeRaw' => false]);

        $result = $client->track('DZ-AL-20251121-00145');

        self::assertNull($result->parcel->raw);
        self::assertNull($result->events[0]->raw);
    }
}
