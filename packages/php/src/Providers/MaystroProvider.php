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
use DzDelivery\Models\ParcelStatus;
use DzDelivery\Models\StopDesk;
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\Text;

/**
 * Maystro Delivery (https://orders-management.maystro-delivery.com).
 * Mapping: docs/PROVIDERS.md#maystro-delivery.
 *
 * Maystro documents no endpoint to read, track or cancel an order (status updates
 * are pushed by webhooks only): track() and cancelParcel() throw NOT_SUPPORTED.
 * Map webhook statuses with StatusMapper::maystro().
 */
final class MaystroProvider implements ShippingProviderInterface
{
    public const NAME = 'maystro';
    public const DEFAULT_BASE_URL = 'https://orders-management.maystro-delivery.com';

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
        $this->http = $http ?? new HttpClient(
            baseUrl: $options->baseUrl ?? self::DEFAULT_BASE_URL,
            provider: self::NAME,
            headers: [
                'Authorization' => preg_match('/^token\s/i', $token) === 1 ? $token : 'Token ' . $token,
                'Content-Type' => 'application/json',
            ],
            timeoutMs: $options->timeoutMs,
            includeRaw: $options->includeRaw,
            handler: is_callable($options->handler) ? $options->handler : null,
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

        $response = $this->http->request('POST', 'api/orders', [], [$order]);

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

    public function track(string $trackingNumber): TrackResult
    {
        throw ShippingError::notSupported(
            'Maystro has no tracking endpoint; use its webhooks (OrderStatusChanged) with StatusMapper::maystro()',
            self::NAME,
        );
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

        $native = $this->http->request('GET', 'api/base/delivery-options/', ['commune' => $communeId]);
        if (!is_array($native) || !array_is_list($native)) {
            throw ShippingError::providerError('Unexpected Maystro delivery-options response', self::NAME, $this->raw($native));
        }

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
        $fee = $query->isStopDesk ? $desk : $home;
        if ($fee === null) {
            throw new ShippingError(ShippingError::NOT_FOUND, 'No Maystro rate for this delivery type', null, null, $this->raw($native), self::NAME);
        }

        return new FeeQuote(deliveryFee: $fee, stopDeskFee: $desk, raw: $this->raw($native));
    }

    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $wilayas = [];
            foreach ($this->list('api/base/wilayas/', ['language' => 'fr', 'country' => 1]) as $w) {
                [$id, $name] = array_is_list((array) $w) ? [$w[0] ?? null, $w[1] ?? null] : [$w['id'] ?? null, $w['name'] ?? null];
                if (!self::hasValue($id)) {
                    continue;
                }
                $wilayas[] = new Location(id: (string) $id, name: (string) $name, parentId: null, code: (string) $id, raw: $this->raw($w));
            }
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
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

    public function cancelParcel(string $trackingNumberOrId): void
    {
        throw ShippingError::notSupported('Maystro has no order cancellation endpoint', self::NAME);
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
