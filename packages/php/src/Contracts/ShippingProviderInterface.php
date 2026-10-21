<?php

declare(strict_types=1);

namespace DzDelivery\Contracts;

use DzDelivery\Models\FeeQuery;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\HealthCheckResult;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelInput;
use DzDelivery\Models\ParcelListPage;
use DzDelivery\Models\ParcelListQuery;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackResult;

/**
 * Unified carrier interface (CONTRACT.md §5). All failures throw
 * \DzDelivery\Errors\ShippingError.
 */
interface ShippingProviderInterface
{
    public function getName(): string;

    /** @param ParcelInput|array<string, mixed> $input */
    public function createParcel(ParcelInput|array $input): Parcel;

    public function track(string $trackingNumber): TrackResult;

    /** @param FeeQuery|array<string, mixed> $query */
    public function getFees(FeeQuery|array $query): FeeQuote;

    /** @return Location[] */
    public function getWilayas(): array;

    /** @return Location[] */
    public function getCommunes(string|int $wilayaId): array;

    /**
     * Stop desks / pickup points of a wilaya (optionally one commune).
     *
     * @param StopDeskQuery|array<string, mixed> $query
     * @return StopDesk[]
     */
    public function getStopDesks(StopDeskQuery|array $query): array;

    /**
     * Paginated account parcels with current unified status (no event history).
     *
     * @param ParcelListQuery|array<string, mixed>|null $query
     */
    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage;

    public function cancelParcel(string $trackingNumberOrId): void;

    /** Lightweight authenticated probe (wilayas listing). Always hits the network. */
    public function healthCheck(): HealthCheckResult;
}
