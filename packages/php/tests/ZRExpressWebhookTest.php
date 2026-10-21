<?php

declare(strict_types=1);

namespace DzDelivery\Tests;

use DzDelivery\Errors\ShippingError;
use DzDelivery\Providers\ZRExpress\Webhook;

final class ZRExpressWebhookTest extends TestCase
{
    public function testParseMapsParcelStateUpdated(): void
    {
        $fixture = self::fixture('zrexpress/webhooks/parcel-state-updated.json');
        $event = Webhook::parse($fixture['body']);

        self::assertSame($fixture['expected']['type'], $event->type);
        self::assertSame($fixture['expected']['parcelId'], $event->parcelId);
        self::assertSame($fixture['expected']['trackingNumber'], $event->trackingNumber);
        self::assertSame($fixture['expected']['orderId'], $event->orderId);
        self::assertSame($fixture['expected']['status'], $event->status);
        self::assertSame($fixture['expected']['occurredAt'], $event->occurredAt);
    }

    public function testVerifyAcceptsValidSignature(): void
    {
        $fixture = self::fixture('zrexpress/webhooks/parcel-state-updated.json');
        $event = Webhook::verify(
            $fixture['rawBody'],
            [
                'svix-id' => $fixture['msgId'],
                'svix-timestamp' => $fixture['msgTimestamp'],
                'svix-signature' => $fixture['signature'],
            ],
            $fixture['secret'],
            null,
            (int) $fixture['msgTimestamp'],
        );

        self::assertSame('parcel.state.updated', $event->type);
        self::assertSame('in_transit', $event->status);
    }

    public function testVerifyRejectsBadSignature(): void
    {
        $fixture = self::fixture('zrexpress/webhooks/parcel-state-updated.json');

        $this->expectException(ShippingError::class);
        Webhook::verify(
            $fixture['rawBody'],
            [
                'svix-id' => $fixture['msgId'],
                'svix-timestamp' => $fixture['msgTimestamp'],
                'svix-signature' => 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            ],
            $fixture['secret'],
            null,
            (int) $fixture['msgTimestamp'],
        );
    }

    public function testVerifyRejectsTimestampSkew(): void
    {
        $fixture = self::fixture('zrexpress/webhooks/parcel-state-updated.json');

        $this->expectException(ShippingError::class);
        Webhook::verify(
            $fixture['rawBody'],
            [
                'svix-id' => $fixture['msgId'],
                'svix-timestamp' => $fixture['msgTimestamp'],
                'svix-signature' => $fixture['signature'],
            ],
            $fixture['secret'],
            300,
            (int) $fixture['msgTimestamp'] + 600,
        );
    }
}
