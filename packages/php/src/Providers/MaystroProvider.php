<?php

declare(strict_types=1);

namespace DzDelivery\Providers;

use DzDelivery\Contracts\ShippingProviderInterface;
use DzDelivery\Errors\ShippingError;
use DzDelivery\Http\HttpClient;
use DzDelivery\Models\ClientOptions;
use DzDelivery\Models\FeeQuery;
use DzDelivery\Models\FeeQuote;
use DzDelivery\Models\HealthCheckResult;
use DzDelivery\Models\Location;
use DzDelivery\Models\Parcel;
use DzDelivery\Models\ParcelInput;
use DzDelivery\Models\ParcelListPage;
use DzDelivery\Models\ParcelListQuery;
use DzDelivery\Models\ParcelStatus;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use DzDelivery\Providers\Maystro\MaystroLabels;
use DzDelivery\Support\Dates;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * Maystro Delivery — orders: https://orders-management.maystro-delivery.com ;
 * live fees: https://backend.maystro-delivery.com (BACKEND_BASE_URL).
 * Mapping: docs/PROVIDERS.md#maystro-delivery.
 *
 * Orders are read, listed and cancelled on the backend host (api/stores/orders/,
 * api/shared/status/{id}/); their status history is on HISTORY_BASE_URL
 * (api/stores/history_order/{id}). These calls take the order UUID (Parcel::$id) or the
 * tracking number (the order display_id, looked up with ?display_id=). Map webhook
 * statuses with StatusMapper::maystro().
 */
final class MaystroProvider implements ShippingProviderInterface
{
    public const NAME = 'maystro';
    public const DEFAULT_BASE_URL = 'https://orders-management.maystro-delivery.com';
    /** Live tariffs host used by Confirmation-api (`getDeliveryPrice`). Orders stay on `DEFAULT_BASE_URL`. */
    public const BACKEND_BASE_URL = 'https://backend.maystro-delivery.com';
    /** Host of the order history endpoint (`api/stores/history_order/{id}`), as documented by Maystro. */
    public const HISTORY_BASE_URL = 'https://b.maystro-delivery.com';

    /** Maystro serves a fixed 20 orders per page on GET api/stores/orders/. */
    private const LIST_PAGE_SIZE = 20;
    private const LIST_MAX_PAGES = 100;
    /** PATCH api/shared/status/{id}/ body that aborts an order (docs: status 50, abort_reason 21). */
    private const STATUS_ABORTED = 50;
    private const ABORT_REASON = 21;
    private const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    /** Orders per getLabels() call (keeps the generated PDF and the request reasonable). */
    private const LABELS_MAX = 100;

    private const DELIVERY_HOME = 1;
    private const DELIVERY_STOP_DESK = 2;
    private const DELIVERY_PICKUP_POINT = 3;

    /** Order error code → [unified code, message, ParcelInput field]. Same table as the TS provider. */
    private const ORDER_ERRORS = [
        10 => [ShippingError::VALIDATION_ERROR, 'Order price is not valid or it was not defined', 'price'],
        20 => [ShippingError::VALIDATION_ERROR, 'Order address is not defined', 'address'],
        30 => [ShippingError::VALIDATION_ERROR, 'Order customer information (name/phone) is not valid or was not defined', 'phone'],
        40 => [ShippingError::NOT_FOUND, 'Order wilaya or commune do not exist or they were not defined', 'communeId'],
        45 => [ShippingError::VALIDATION_ERROR, 'Order delivery type does not exist for the provided commune', 'isStopDesk'],
        50 => [ShippingError::VALIDATION_ERROR, 'Order products are missing, inconsistent or not valid', 'productList'],
        55 => [ShippingError::VALIDATION_ERROR, 'Duplicated order (same customer name/phone in the last 24 hours)', null],
        60 => [ShippingError::PROVIDER_ERROR, 'Unexpected Maystro error (contact Maystro support)', null],
        70 => [ShippingError::PROVIDER_ERROR, 'Maystro could not determine the delivery price (contact Maystro support)', null],
        80 => [ShippingError::VALIDATION_ERROR, 'Orders list is empty', null],
        90 => [ShippingError::VALIDATION_ERROR, 'Too many orders in one request', null],
        100 => [ShippingError::VALIDATION_ERROR, 'Order external ID exceeds 100 characters', 'orderId'],
        101 => [ShippingError::VALIDATION_ERROR, 'Cannot pay the delivery price with points (not enough points)', null],
    ];

    private HttpClient $http;
    /** Same token as `$http`, pointed at `BACKEND_BASE_URL` for live `delivery_price`. */
    private HttpClient $backendHttp;
    /** Same token, pointed at `HISTORY_BASE_URL` for the order history. */
    private HttpClient $historyHttp;
    private bool $includeRaw;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, Location[]> keyed by wilaya id */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $token = trim((string) $options->get('apiToken', ''));
        if ($token === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'Maystro requires "apiToken"', null, null, null, self::NAME);
        }

        $this->includeRaw = $options->includeRaw;
        $headers = [
            'Authorization' => preg_match('/^token\s/i', $token) === 1 ? $token : 'Token ' . $token,
            'Content-Type' => 'application/json',
        ];
        $handler = is_callable($options->handler) ? $options->handler : null;
        $this->http = $http ?? new HttpClient(
            baseUrl: $options->baseUrl ?? self::DEFAULT_BASE_URL,
            provider: self::NAME,
            headers: $headers,
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: $handler,
            errorParser: [self::class, 'parseError'],
        );
        $this->backendHttp = new HttpClient(
            baseUrl: self::BACKEND_BASE_URL,
            provider: self::NAME,
            headers: $headers,
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: $handler,
            errorParser: [self::class, 'parseError'],
        );
        $this->historyHttp = new HttpClient(
            baseUrl: self::HISTORY_BASE_URL,
            provider: self::NAME,
            headers: $headers,
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: $handler,
            errorParser: [self::class, 'parseError'],
        );
    }

    public function getName(): string
    {
        return self::NAME;
    }

    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toLocal($input->phone2, self::NAME, 'phone2') : null;

        $wilaya = $this->findWilaya($input->wilayaId ?? $input->wilayaName, $input->wilayaId === null);
        $commune = $this->findCommune($wilaya, $input->communeId ?? $input->communeName, $input->communeId === null);

        $details = [];
        if ($input->productList !== null && $input->productList !== []) {
            foreach ($input->productList as $item) {
                $details[] = ['product' => trim((string) $item->sku), 'description' => trim($item->name), 'quantity' => $item->quantity];
            }
        } else {
            $details[] = ['product' => '', 'description' => trim((string) $input->productName), 'quantity' => 1];
        }

        $order = [
            'customer_name' => trim($input->recipientName),
            'customer_phone' => $phone,
            'destination_text' => trim($input->address),
            // total_price includes the delivery fee: it is exactly what the recipient pays.
            'total_price' => (int) round($input->price),
            'wilaya' => $wilaya->name,
            'commune' => self::idValue($commune->id),
            'delivery_type' => self::DELIVERY_HOME,
            'express' => false,
            'details' => $details,
        ];
        if ($phone2 !== null) {
            $order['customer_phone2'] = $phone2;
        }
        if ($input->remark !== null && trim($input->remark) !== '') {
            $order['note_to_driver'] = trim($input->remark);
        }
        if ($input->orderId !== null && trim($input->orderId) !== '') {
            $order['external_id'] = trim($input->orderId);
        }
        if ($input->isStopDesk) {
            $desk = trim((string) $input->stopDeskId);
            if ($desk === $commune->id) {
                $order['delivery_type'] = self::DELIVERY_STOP_DESK;
            } else {
                $order['delivery_type'] = self::DELIVERY_PICKUP_POINT;
                $order['pickup_point'] = self::idValue($desk);
            }
        }

        // Trailing slash matches the live orders-management URL used by Delivery/MaystroController.
        $response = $this->http->request('POST', 'api/orders/', [], [$order]);

        $row = is_array($response) && array_is_list($response) ? ($response[0] ?? null) : $response;
        if (!self::isOrderRow($row)) {
            throw ShippingError::providerError('Unexpected Maystro create response', self::NAME, $this->raw($response));
        }
        if (($row['success'] ?? false) !== true || (is_array($row['errors'] ?? null) && $row['errors'] !== [])) {
            [$code, $message, $errorDetails] = self::summarizeOrderErrors($row['errors'] ?? []);
            throw new ShippingError($code, $message, null, $errorDetails, $this->raw($response), self::NAME);
        }
        if (!self::hasValue($row['tracking'] ?? null)) {
            throw ShippingError::providerError('Maystro did not return a tracking number', self::NAME, $this->raw($response));
        }

        // The response carries no status; new orders start as CREATED (4) → pending.
        $tracking = (string) $row['tracking'];

        return new Parcel(
            self::hasValue($row['id'] ?? null) ? (string) $row['id'] : $tracking,
            $tracking,
            ParcelStatus::PENDING,
            self::NAME,
            $this->raw($row),
        );
    }

    /**
     * Order (GET {backend}/api/stores/orders/{id}/) + status history
     * (GET {b}/api/stores/history_order/{id}, oldest first). $trackingNumber is the order
     * UUID (Parcel::$id from createParcel) or its display_id (the tracking number createParcel returns).
     */
    public function track(string $trackingNumber): TrackResult
    {
        $ref = trim($trackingNumber);
        if ($ref === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        $order = $this->resolveOrder($ref);
        $body = $this->historyHttp->request('GET', 'api/stores/history_order/' . rawurlencode((string) $order['id']));
        $rows = is_array($body) && array_is_list($body)
            ? $body
            : (is_array($body) && is_array($body['results'] ?? null) ? array_values($body['results']) : null);
        if ($rows === null) {
            throw ShippingError::providerError('Unexpected Maystro order history response', self::NAME, $this->raw($body));
        }

        $sorted = [];
        foreach ($rows as $i => $row) {
            if (is_array($row) && !array_is_list($row)) {
                $sorted[] = ['row' => $row, 'i' => $i, 'at' => Dates::toIso(is_scalar($row['created_at'] ?? null) ? (string) $row['created_at'] : '')];
            }
        }
        usort($sorted, static fn (array $x, array $y) => Dates::compare($x['at'], $y['at']) ?: $x['i'] <=> $y['i']);

        $events = [];
        foreach ($sorted as ['row' => $row, 'at' => $at]) {
            $code = $row['status'] ?? null;
            $codeText = is_scalar($code) ? trim((string) $code) : '';
            $name = ctype_digit($codeText) ? (StatusMapper::MAYSTRO_STATUS_CODES[(int) $codeText] ?? null) : ($codeText !== '' ? $codeText : null);
            $base = $name ?? $codeText;
            $comment = is_scalar($row['comment'] ?? null) ? (string) $row['comment'] : '';
            $label = $base !== '' && $comment !== '' ? "$base ($comment)" : ($base !== '' ? $base : $comment);
            $events[] = new TrackingEvent(
                status: StatusMapper::maystro(is_int($code) || is_string($code) ? $code : null),
                label: $label,
                at: $at,
                raw: $this->raw($row),
            );
        }

        return new TrackResult($this->toParcel($order), $events);
    }

    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);

        if ($query->toCommuneId !== null) {
            $communeId = trim((string) $query->toCommuneId);
        } else {
            $wilaya = $this->findWilaya($query->toWilayaId, !ctype_digit(trim((string) $query->toWilayaId)));
            $first = $this->communesOf($wilaya->id)[0] ?? null;
            if ($first === null) {
                throw ShippingError::notFound('No Maystro commune in wilaya ' . $wilaya->name, self::NAME);
            }
            $communeId = $first->id;
        }

        // Prefer Confirmation's live backend delivery_price; on NOT_FOUND / NETWORK_ERROR
        // fall back to orders-management delivery-options then delivery-prices.
        try {
            return $this->feeQuoteFromStoresPrice($communeId, $query->isStopDesk);
        } catch (ShippingError $e) {
            if ($e->code !== ShippingError::NOT_FOUND && $e->code !== ShippingError::NETWORK_ERROR) {
                throw $e;
            }
        }

        try {
            $native = $this->http->request('GET', 'api/base/delivery-options/', ['commune' => $communeId]);
            if (is_array($native) && array_is_list($native)) {
                return $this->feeQuoteFromOptions($native, $query->isStopDesk);
            }
        } catch (ShippingError $e) {
            if ($e->code !== ShippingError::NOT_FOUND) {
                throw $e;
            }
        }

        return $this->feeQuoteFromPrices($communeId, $query->isStopDesk);
    }

    /** Confirmation-api live tariffs: `backend.maystro-delivery.com/api/stores/delivery_price/`. */
    private function feeQuoteFromStoresPrice(string $communeId, bool $isStopDesk): FeeQuote
    {
        $homeBody = $this->storesDeliveryPrice($communeId, self::DELIVERY_HOME);
        $deskBody = $this->storesDeliveryPriceOrNull($communeId, self::DELIVERY_STOP_DESK);

        $home = self::number($homeBody['delivery_price'] ?? null);
        $desk = $deskBody !== null ? self::number($deskBody['delivery_price'] ?? null) : null;
        $fee = $isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No Maystro rate for this delivery type',
                null,
                null,
                $this->raw(['home' => $homeBody, 'stopdesk' => $deskBody]),
                self::NAME,
            );
        }

        return new FeeQuote(
            deliveryFee: $fee,
            stopDeskFee: $desk,
            raw: $this->raw(['home' => $homeBody, 'stopdesk' => $deskBody]),
        );
    }

    /** @return array<string, mixed> */
    private function storesDeliveryPrice(string $communeId, int $deliveryType): array
    {
        $native = $this->backendHttp->request('GET', 'api/stores/delivery_price/', [
            'commune' => $communeId,
            'delivery_type' => $deliveryType,
            'express' => 'false',
        ]);
        if (!is_array($native) || array_is_list($native) || !array_key_exists('delivery_price', $native)) {
            throw ShippingError::providerError('Unexpected Maystro stores/delivery_price response', self::NAME, $this->raw($native));
        }

        return $native;
    }

    /** @return array<string, mixed>|null */
    private function storesDeliveryPriceOrNull(string $communeId, int $deliveryType): ?array
    {
        try {
            return $this->storesDeliveryPrice($communeId, $deliveryType);
        } catch (ShippingError $e) {
            if ($e->code === ShippingError::NOT_FOUND) {
                return null;
            }
            throw $e;
        }
    }

    /** @param list<mixed> $native */
    private function feeQuoteFromOptions(array $native, bool $isStopDesk): FeeQuote
    {
        $priceOf = static function (string $type) use ($native): int|float|null {
            foreach ($native as $option) {
                if (is_array($option) && Text::key((string) ($option['type'] ?? '')) === $type) {
                    return self::number($option['price'] ?? $option['delivery_price'] ?? null);
                }
            }

            return null;
        };
        $home = $priceOf('home');
        $desk = $priceOf('stopdesk') ?? $priceOf('pickup');
        $fee = $isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(ShippingError::NOT_FOUND, 'No Maystro rate for this delivery type', null, null, $this->raw($native), self::NAME);
        }

        return new FeeQuote(deliveryFee: $fee, stopDeskFee: $desk, raw: $this->raw($native));
    }

    private function feeQuoteFromPrices(string $communeId, bool $isStopDesk): FeeQuote
    {
        $homeBody = $this->deliveryPrice($communeId, self::DELIVERY_HOME);
        $deskBody = $this->deliveryPriceOrNull($communeId, self::DELIVERY_STOP_DESK)
            ?? $this->deliveryPriceOrNull($communeId, self::DELIVERY_PICKUP_POINT);

        $home = self::number($homeBody['delivery_price'] ?? null);
        $desk = $deskBody !== null ? self::number($deskBody['delivery_price'] ?? null) : null;
        $fee = $isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No Maystro rate for this delivery type',
                null,
                null,
                $this->raw(['home' => $homeBody, 'stopdesk' => $deskBody]),
                self::NAME,
            );
        }

        return new FeeQuote(
            deliveryFee: $fee,
            stopDeskFee: $desk,
            raw: $this->raw(['home' => $homeBody, 'stopdesk' => $deskBody]),
        );
    }

    /** @return array<string, mixed> */
    private function deliveryPrice(string $communeId, int $deliveryType): array
    {
        $native = $this->http->request('GET', 'api/base/delivery-prices/', [
            'commune' => $communeId,
            'delivery_type' => $deliveryType,
        ]);
        if (!is_array($native) || array_is_list($native) || !array_key_exists('delivery_price', $native)) {
            throw ShippingError::providerError('Unexpected Maystro delivery-prices response', self::NAME, $this->raw($native));
        }

        return $native;
    }

    /** @return array<string, mixed>|null */
    private function deliveryPriceOrNull(string $communeId, int $deliveryType): ?array
    {
        try {
            return $this->deliveryPrice($communeId, $deliveryType);
        } catch (ShippingError $e) {
            if ($e->code === ShippingError::NOT_FOUND) {
                return null;
            }
            throw $e;
        }
    }

    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $wilayas = [];
            foreach ($this->list('api/base/wilayas/', ['language' => 'fr', 'country' => 1]) as $w) {
                [$id, $name] = self::parseWilayaRow($w);
                if (!self::hasValue($id)) {
                    continue;
                }
                $wilayas[] = new Location(id: (string) $id, name: (string) $name, parentId: null, code: (string) $id, raw: $this->raw($w));
            }
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
    }

    /**
     * Maystro historically returned `[id, name]` tuples; current API returns
     * `{ code|display_id|id, name_lt|name, … }`. Both shapes are accepted.
     *
     * @return array{0: mixed, 1: mixed}
     */
    private static function parseWilayaRow(mixed $w): array
    {
        if (is_array($w) && array_is_list($w)) {
            return [$w[0] ?? null, $w[1] ?? null];
        }
        if (!is_array($w)) {
            return [null, null];
        }

        $id = $w['code'] ?? $w['display_id'] ?? $w['id'] ?? null;
        $name = $w['name_lt'] ?? $w['name'] ?? $w['name_ar'] ?? null;

        return [$id, $name];
    }

    public function getCommunes(string|int $wilayaId): array
    {
        $wilaya = $this->findWilaya($wilayaId, !ctype_digit(trim((string) $wilayaId)));

        return $this->communesOf($wilaya->id);
    }

    /**
     * `GET api/base/pickup-points?commune=` (one commune, so `communeId` is required). A Maystro
     * stop desk has no id of its own: its id is the commune id (→ `delivery_type: 2` on create);
     * pickup points use their `pickup_point` id (→ `delivery_type: 3`). Inactive entries are skipped.
     */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        if ($query->communeId === null) {
            throw ShippingError::validation('Maystro lists stop desks per commune: communeId is required', self::NAME, 'communeId');
        }
        $wilaya = $this->findWilaya($query->wilayaId, !ctype_digit(trim((string) $query->wilayaId)));
        $commune = $this->findCommune($wilaya, $query->communeId, !ctype_digit(trim((string) $query->communeId)));

        $desks = [];
        foreach ($this->list('api/base/pickup-points', ['commune' => $commune->id]) as $p) {
            if (!is_array($p) || ($p['active'] ?? true) === false) {
                continue;
            }
            $isPickupPoint = (int) ($p['delivery_type'] ?? 0) === self::DELIVERY_PICKUP_POINT || self::hasValue($p['pickup_point'] ?? null);
            if ($isPickupPoint && !self::hasValue($p['pickup_point'] ?? null)) {
                continue;
            }
            $desks[] = new StopDesk(
                id: $isPickupPoint ? (string) $p['pickup_point'] : $commune->id,
                name: (string) ($p['name_lt'] ?? $p['name_ar'] ?? $p['name'] ?? ''),
                communeId: self::hasValue($p['commune'] ?? null) ? (string) $p['commune'] : $commune->id,
                wilayaId: $wilaya->id,
                raw: $this->raw($p),
            );
        }

        return $desks;
    }

    /**
     * GET {backend}/api/stores/orders/?page= (Maystro serves a fixed 20 orders per page, so
     * pageSize is always 20). status, orderId (external_order_id), keyword (display id,
     * tracking, customer name or phone) and updatedSince (order updated_at) filter the
     * fetched page client-side: the API has no such query parameters.
     */
    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage
    {
        $query = ParcelListQuery::from($query, self::NAME);
        if ($query->updatedSince !== null && strtotime($query->updatedSince) === false) {
            throw ShippingError::validation('updatedSince must be an ISO 8601 date', self::NAME, 'updatedSince');
        }

        if ($query->allPages) {
            $all = [];
            $totalCount = 0;
            $lastRaw = null;
            $hasNext = true;
            for ($n = 1; $hasNext && $n <= self::LIST_MAX_PAGES; $n++) {
                [$parcels, $count, $hasNext, $lastRaw] = $this->listPage($query, $n);
                array_push($all, ...$parcels);
                if ($n === 1) {
                    $totalCount = $count;
                }
            }

            // hasNext stays true when the page cap cut the walk short.
            return new ParcelListPage($all, 1, self::LIST_PAGE_SIZE, $totalCount, $hasNext, $this->raw($lastRaw));
        }

        [$parcels, $totalCount, $hasNext, $raw] = $this->listPage($query, $query->page);

        return new ParcelListPage($parcels, $query->page, self::LIST_PAGE_SIZE, $totalCount, $hasNext, $this->raw($raw));
    }

    /**
     * PATCH {backend}/api/shared/status/{id}/ with { status: 50, abort_reason: 21 } (abort).
     * Takes the order UUID (Parcel::$id) or the tracking number (display_id). Unknown order →
     * NOT_FOUND; an answer whose new_status is not 50 → VALIDATION_ERROR (the order was not aborted).
     */
    public function cancelParcel(string $trackingNumberOrId): void
    {
        $ref = trim($trackingNumberOrId);
        if ($ref === '') {
            throw ShippingError::validation('trackingNumberOrId is required', self::NAME, 'trackingNumberOrId');
        }

        $orderId = preg_match(self::UUID_RE, $ref) === 1 ? $ref : (string) $this->resolveOrder($ref)['id'];
        $body = $this->backendHttp->request(
            'PATCH',
            'api/shared/status/' . rawurlencode($orderId) . '/',
            [],
            ['status' => self::STATUS_ABORTED, 'abort_reason' => self::ABORT_REASON],
        );
        if (is_array($body) && self::hasValue($body['new_status'] ?? null) && (int) $body['new_status'] !== self::STATUS_ABORTED) {
            throw new ShippingError(
                ShippingError::VALIDATION_ERROR,
                "Maystro did not cancel order $ref (status {$body['new_status']})",
                null,
                null,
                $this->raw($body),
                self::NAME,
            );
        }
    }

    /**
     * Maystro extra (not on the common interface): the shipping labels (bordereaux) of one or
     * more orders, as one PDF with a page per order.
     *
     * - Tracking numbers (display_id) → POST {backend}/api/delivery/starter/starter_bordureau/;
     *   order UUIDs (Parcel::$id) → POST {backend}/api/delivery/starter/v2/starter_bordureau/
     *   ({ orders_ids: [...] }). A mix is sent as tracking numbers (each UUID costs one order read).
     * - Maystro silently drops unknown references and dedupes repeats: labelCount is the number of
     *   labels in the PDF, so labelCount < count($references) means some were not found. When none
     *   is found Maystro returns a blank page: that throws NOT_FOUND.
     *
     * @param list<string> $references
     */
    public function getLabels(array $references): MaystroLabels
    {
        $refs = [];
        foreach ($references as $ref) {
            $ref = is_scalar($ref) ? trim((string) $ref) : '';
            if ($ref !== '' && !in_array($ref, $refs, true)) {
                $refs[] = $ref;
            }
        }
        if ($refs === []) {
            throw ShippingError::validation('getLabels requires at least one order reference', self::NAME, 'references');
        }
        if (count($refs) > self::LABELS_MAX) {
            throw ShippingError::validation('getLabels accepts at most ' . self::LABELS_MAX . ' orders per call', self::NAME, 'references');
        }

        $byUuid = array_reduce($refs, static fn (bool $all, string $r) => $all && preg_match(self::UUID_RE, $r) === 1, true);
        $ids = $refs;
        if (!$byUuid) {
            // Mixed: UUIDs become tracking numbers; an unknown UUID is dropped, like Maystro drops
            // unknown tracking numbers, so the other labels are still returned.
            $ids = [];
            foreach ($refs as $r) {
                if (preg_match(self::UUID_RE, $r) !== 1) {
                    $ids[] = $r;
                    continue;
                }
                try {
                    $ids[] = (string) ($this->resolveOrder($r)['display_id'] ?? $r);
                } catch (ShippingError $e) {
                    if ($e->code !== ShippingError::NOT_FOUND) {
                        throw $e;
                    }
                }
            }
        }
        $response = $this->backendHttp->requestBinary(
            'POST',
            $byUuid ? 'api/delivery/starter/v2/starter_bordureau/' : 'api/delivery/starter/starter_bordureau/',
            [],
            ['orders_ids' => $ids],
            // Maystro answers HTTP 406 to `Accept: application/pdf` (checked live); */* gets the PDF.
            ['Accept' => '*/*'],
        );
        $pdf = $response['body'];
        if (!str_starts_with($pdf, '%PDF')) {
            throw ShippingError::providerError('Maystro did not return a PDF label', self::NAME);
        }
        $labelCount = self::countPdfLabels($pdf);
        if ($labelCount === 0) {
            throw ShippingError::notFound('No Maystro order found for: ' . implode(', ', $refs), self::NAME);
        }

        return new MaystroLabels($pdf, $labelCount);
    }

    /**
     * Pages of a Maystro label PDF that carry a label. Each label page embeds its barcode as an
     * image; the blank page Maystro returns when no order matched has none (checked live).
     */
    private static function countPdfLabels(string $pdf): int
    {
        if (preg_match('~/Subtype\s*/Image~', $pdf) !== 1) {
            return 0;
        }

        return (int) preg_match_all('~/Type\s*/Page(?!s)~', $pdf);
    }

    /** Probes `GET api/base/wilayas/` (bypasses cache). */
    public function healthCheck(): HealthCheckResult
    {
        return Health::probeWilayas(
            self::NAME,
            function (): void {
                $this->wilayas = null;
            },
            fn () => $this->getWilayas(),
        );
    }

    /**
     * Extracts [message, details] from Maystro error bodies: order result rows
     * (`[{ success, errors }]`), DRF `{ detail }` or `{ field: [messages] }`.
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        if (is_array($body) && array_is_list($body) && self::isOrderRow($body[0] ?? null)) {
            [, $message, $details] = self::summarizeOrderErrors($body[0]['errors'] ?? []);

            return [$message, $details];
        }
        if (!is_array($body)) {
            return HttpClient::defaultErrorParser($status, $body);
        }

        $message = null;
        foreach (['detail', 'message', 'error'] as $key) {
            if (is_string($body[$key] ?? null)) {
                $message = $body[$key];
                break;
            }
        }
        $details = [];
        foreach ($body as $field => $value) {
            if (in_array($field, ['detail', 'message', 'error'], true)) {
                continue;
            }
            foreach (is_array($value) ? $value : [$value] as $msg) {
                if (is_string($msg)) {
                    $details[] = ['field' => (string) $field, 'message' => $msg];
                }
            }
        }

        return [$message ?? implode('; ', array_column($details, 'message')), $details === [] ? null : $details];
    }

    /**
     * `errors` of a rejected order row → [unified code, message, details]. Entries may be
     * bare codes (`40`) or objects (`{ code, message }`); the first known code decides.
     *
     * @return array{0: string, 1: string, 2: list<array<string, string>>}
     */
    private static function summarizeOrderErrors(mixed $errors): array
    {
        $code = null;
        $details = [];
        foreach (is_array($errors) ? $errors : [] as $entry) {
            $nativeCode = null;
            $nativeMessage = null;
            if (is_array($entry)) {
                $nativeCode = $entry['code'] ?? $entry['error_code'] ?? null;
                $nativeMessage = isset($entry['message']) || isset($entry['detail']) ? (string) ($entry['message'] ?? $entry['detail']) : null;
            } elseif (is_string($entry) && !ctype_digit(trim($entry))) {
                $nativeMessage = $entry;
            } else {
                $nativeCode = $entry;
            }
            $known = self::hasValue($nativeCode) ? (self::ORDER_ERRORS[(int) $nativeCode] ?? null) : null;
            $code ??= $known[0] ?? null;

            $detail = [];
            if (($known[2] ?? null) !== null) {
                $detail['field'] = $known[2];
            }
            $detail['message'] = $nativeMessage !== null && $nativeMessage !== ''
                ? $nativeMessage
                : ($known[1] ?? (self::hasValue($nativeCode) ? 'Maystro error code ' . $nativeCode : 'Maystro rejected the order'));
            if (self::hasValue($nativeCode)) {
                $detail['code'] = trim((string) $nativeCode);
            }
            $details[] = $detail;
        }

        $message = $details === [] ? 'Maystro rejected the order' : implode('; ', array_column($details, 'message'));

        return [$code ?? ShippingError::VALIDATION_ERROR, $message, $details];
    }

    /**
     * Order UUID → GET {backend}/api/stores/orders/{id}/ (404 → NOT_FOUND). A numeric
     * reference is looked up with GET {backend}/api/stores/orders/?display_id=.
     *
     * @return array<string, mixed>
     */
    private function resolveOrder(string $ref): array
    {
        if (preg_match(self::UUID_RE, $ref) === 1) {
            $body = $this->backendHttp->request('GET', 'api/stores/orders/' . rawurlencode($ref) . '/');
            if (!is_array($body) || array_is_list($body) || !self::hasValue($body['id'] ?? null)) {
                throw ShippingError::providerError('Unexpected Maystro order response', self::NAME, $this->raw($body));
            }

            return $body;
        }
        if (ctype_digit($ref)) {
            $body = $this->backendHttp->request('GET', 'api/stores/orders/', ['display_id' => $ref]);
            foreach (self::ordersPage($body, $this->raw($body))[0] as $order) {
                if (
                    self::hasValue($order['id'] ?? null)
                    && (trim((string) ($order['display_id'] ?? '')) === $ref || trim((string) ($order['tracking'] ?? '')) === $ref)
                ) {
                    return $order;
                }
            }
        }

        throw ShippingError::notFound(
            "Unknown Maystro order: $ref (pass Parcel::\$id or the tracking number returned by createParcel)",
            self::NAME,
        );
    }

    /**
     * @return array{0: list<Parcel>, 1: int, 2: bool, 3: mixed}
     */
    private function listPage(ParcelListQuery $query, int $page): array
    {
        $body = $this->backendHttp->request('GET', 'api/stores/orders/', ['page' => $page]);
        [$items, $count, $hasNext] = self::ordersPage($body, $this->raw($body));

        $orderId = $query->orderId !== null ? trim($query->orderId) : null;
        $keyword = $query->keyword !== null ? mb_strtolower(trim($query->keyword)) : null;
        // DateTimeImmutable keeps the microseconds of Maystro's `updated_at` (strtotime() would not).
        $since = $query->updatedSince !== null ? new \DateTimeImmutable($query->updatedSince) : null;

        $parcels = [];
        foreach ($items as $order) {
            if (!self::hasValue($order['id'] ?? null)) {
                continue;
            }
            if ($orderId !== null && $orderId !== '' && trim((string) ($order['external_order_id'] ?? '')) !== $orderId) {
                continue;
            }
            if ($since !== null) {
                try {
                    $updated = is_string($order['updated_at'] ?? null) ? new \DateTimeImmutable($order['updated_at']) : null;
                } catch (\Exception) {
                    $updated = null;
                }
                if ($updated === null || $updated < $since) {
                    continue;
                }
            }
            if ($keyword !== null && $keyword !== '') {
                $match = false;
                foreach (['display_id', 'tracking', 'customer_name', 'customer_phone', 'external_order_id'] as $field) {
                    if (self::hasValue($order[$field] ?? null) && str_contains(mb_strtolower((string) $order[$field]), $keyword)) {
                        $match = true;
                        break;
                    }
                }
                if (!$match) {
                    continue;
                }
            }
            $parcel = $this->toParcel($order);
            if ($query->status === null || $parcel->status === $query->status) {
                $parcels[] = $parcel;
            }
        }

        return [
            $parcels,
            $count ?? ($page - 1) * self::LIST_PAGE_SIZE + count($items),
            $hasNext ?? count($items) === self::LIST_PAGE_SIZE,
            $body,
        ];
    }

    /**
     * GET api/stores/orders/ page → [rows, count, hasNext]. The docs wrap the DRF page in
     * `list` ({ list: { count, next, previous, results } }); a bare DRF page or a plain array
     * is accepted too.
     *
     * @return array{0: list<array<string, mixed>>, 1: ?int, 2: ?bool}
     */
    private static function ordersPage(mixed $body, mixed $raw): array
    {
        $page = is_array($body) && is_array($body['list'] ?? null) ? $body['list'] : $body;
        $rows = static fn (array $list) => array_values(array_filter($list, static fn ($o) => is_array($o) && !array_is_list($o)));
        if (is_array($page) && array_is_list($page)) {
            return [$rows($page), null, null];
        }
        if (!is_array($page) || !is_array($page['results'] ?? null)) {
            throw ShippingError::providerError('Unexpected Maystro orders response', self::NAME, $raw);
        }
        $count = self::number($page['count'] ?? null);

        return [
            $rows($page['results']),
            $count !== null ? (int) $count : null,
            array_key_exists('next', $page) ? self::hasValue($page['next']) : null,
        ];
    }

    /**
     * Order row → Parcel. id is the order UUID; the tracking number is its display_id
     * (the number createParcel returns as tracking), or tracking when a row carries one.
     *
     * @param array<string, mixed> $order
     */
    private function toParcel(array $order): Parcel
    {
        $id = (string) $order['id'];
        $tracking = self::hasValue($order['tracking'] ?? null)
            ? trim((string) $order['tracking'])
            : (self::hasValue($order['display_id'] ?? null) ? trim((string) $order['display_id']) : $id);
        $status = $order['status'] ?? null;

        return new Parcel($id, $tracking, StatusMapper::maystro(is_int($status) || is_string($status) ? $status : null), self::NAME, $this->raw($order));
    }

    private static function isOrderRow(mixed $value): bool
    {
        return is_array($value) && !array_is_list($value) && (array_key_exists('errors', $value) || array_key_exists('success', $value));
    }

    /** @return Location[] */
    private function communesOf(string $wilayaId): array
    {
        if (!isset($this->communes[$wilayaId])) {
            $communes = [];
            foreach ($this->list('api/base/communes/', ['wilaya' => $wilayaId]) as $c) {
                if (!is_array($c) || !self::hasValue($c['id'] ?? null)) {
                    continue;
                }
                $communes[] = new Location(
                    id: (string) $c['id'],
                    name: (string) ($c['name'] ?? ''),
                    parentId: (string) ($c['wilaya'] ?? $wilayaId),
                    code: self::hasValue($c['postcode'] ?? null) ? (string) $c['postcode'] : null,
                    raw: $this->raw($c),
                );
            }
            $this->communes[$wilayaId] = $communes;
        }

        return $this->communes[$wilayaId];
    }

    /**
     * Plain JSON list (or a DRF `{ results: [...] }` page, first page only).
     *
     * @param array<string, mixed> $query
     * @return list<mixed>
     */
    private function list(string $path, array $query): array
    {
        $response = $this->http->request('GET', $path, $query);
        if (is_array($response) && array_is_list($response)) {
            return $response;
        }
        if (is_array($response) && is_array($response['results'] ?? null)) {
            return array_values($response['results']);
        }

        throw ShippingError::providerError("Unexpected Maystro response for $path", self::NAME, $this->raw($response));
    }

    /** Wilaya by Maystro id (= official code 1–58) or by name. */
    private function findWilaya(string|int|null $value, bool $byName): Location
    {
        $value = trim((string) $value);
        foreach ($this->getWilayas() as $w) {
            if ($byName ? Text::key($w->name) === Text::key($value) : (ctype_digit($value) && (int) $w->id === (int) $value)) {
                return $w;
            }
        }

        throw ShippingError::notFound('Unknown wilaya: ' . $value, self::NAME);
    }

    private function findCommune(Location $wilaya, string|int|null $value, bool $byName): Location
    {
        $value = trim((string) $value);
        foreach ($this->communesOf($wilaya->id) as $c) {
            if ($byName ? Text::key($c->name) === Text::key($value) : $c->id === $value) {
                return $c;
            }
        }

        throw ShippingError::notFound('Unknown commune: ' . $value . ' in wilaya ' . $wilaya->name, self::NAME);
    }

    /** Numeric strings → int (Maystro ids are integers), anything else unchanged. */
    private static function idValue(string $value): string|int
    {
        return ctype_digit($value) ? (int) $value : $value;
    }

    private static function hasValue(mixed $value): bool
    {
        return is_scalar($value) && trim((string) $value) !== '';
    }

    private static function number(mixed $value): int|float|null
    {
        return is_numeric($value) ? $value + 0 : null;
    }

    private function raw(mixed $value): mixed
    {
        return $this->includeRaw ? $value : null;
    }
}
