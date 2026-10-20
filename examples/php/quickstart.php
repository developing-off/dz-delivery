<?php

/**
 * dz-delivery PHP quickstart.
 *
 *   cd packages/php && composer install
 *   ZREXPRESS_API_KEY=... ZREXPRESS_TENANT=... php ../../examples/php/quickstart.php
 *
 * Set DZ_PROVIDER=yalidine (with YALIDINE_API_ID / YALIDINE_API_TOKEN / YALIDINE_FROM_WILAYA_ID)
 * or DZ_PROVIDER=maystro (with MAYSTRO_API_TOKEN), or DZ_PROVIDER=ecotrack (with ECOTRACK_TOKEN and
 * ECOTRACK_COURIER or ECOTRACK_BASE_URL) to try another carrier.
 * Set DZ_CREATE=1 to actually create a parcel.
 */

declare(strict_types=1);

require __DIR__ . '/../../packages/php/vendor/autoload.php';

use DzDelivery\ClientFactory;
use DzDelivery\Errors\ShippingError;

$provider = getenv('DZ_PROVIDER') ?: 'zrexpress';

$options = match ($provider) {
    'zrexpress' => [
        'apiKey' => getenv('ZREXPRESS_API_KEY') ?: '',
        'tenant' => getenv('ZREXPRESS_TENANT') ?: '',
    ],
    'yalidine' => [
        'apiId' => getenv('YALIDINE_API_ID') ?: '',
        'apiToken' => getenv('YALIDINE_API_TOKEN') ?: '',
        'fromWilayaId' => (int) (getenv('YALIDINE_FROM_WILAYA_ID') ?: 16),
    ],
    'maystro' => [
        'apiToken' => getenv('MAYSTRO_API_TOKEN') ?: '',
    ],
    'ecotrack' => array_filter([
        'token' => getenv('ECOTRACK_TOKEN') ?: '',
        'courier' => getenv('ECOTRACK_COURIER') ?: null,
        'baseUrl' => getenv('ECOTRACK_BASE_URL') ?: null,
    ], static fn ($v) => $v !== null),
    default => [],
};

try {
    $client = ClientFactory::create($provider, $options + ['includeRaw' => false]);

    $wilayas = $client->getWilayas();
    printf("%d wilayas, e.g. %s (code %s)\n", count($wilayas), $wilayas[0]->name ?? '-', $wilayas[0]->code ?? '-');

    $communes = $client->getCommunes(16);
    printf("%d communes in Alger\n", count($communes));

    $quote = $client->getFees(['toWilayaId' => 16]);
    printf("Home delivery to Alger: %s %s\n", $quote->deliveryFee, $quote->currency);

    if (getenv('DZ_CREATE') === '1') {
        $parcel = $client->createParcel([
            'recipientName' => 'Client Test',
            'phone' => '0550123456',
            'address' => '12 rue des Tests',
            'wilayaId' => 16,
            'communeName' => $communes[0]->name ?? 'Bab Ezzouar',
            'productName' => 'T-shirt',
            'price' => 2500,
            'orderId' => 'demo-' . time(),
        ]);
        printf("Created %s (%s)\n", $parcel->trackingNumber, $parcel->status);

        // Maystro has no tracking / cancellation API (NOT_SUPPORTED): skip those steps.
        try {
            $tracked = $client->track($parcel->trackingNumber);
            foreach ($tracked->events as $event) {
                printf("  %s  %-10s %s\n", $event->at, $event->status, $event->label);
            }

            $client->cancelParcel($parcel->trackingNumber);
            echo "Cancelled\n";
        } catch (ShippingError $e) {
            if ($e->code !== ShippingError::NOT_SUPPORTED) {
                throw $e;
            }
            echo "Tracking / cancellation not supported by $provider: cancel the parcel from its dashboard\n";
        }
    }
} catch (ShippingError $e) {
    fprintf(STDERR, "[%s] %s (HTTP %s)\n", $e->code, $e->getMessage(), $e->httpStatus ?? '-');
    exit(1);
}
