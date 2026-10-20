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
use DzDelivery\Models\StopDeskQuery;
use DzDelivery\Models\TrackingEvent;
use DzDelivery\Models\TrackResult;
use DzDelivery\Support\Dates;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * ZRExpress (https://docs.zrexpress.app/reference). Mapping: docs/PROVIDERS.md#zrexpress.
 */
final class ZRExpressProvider implements ShippingProviderInterface
{
    public const NAME = 'zrexpress';
    public const DEFAULT_BASE_URL = 'https://api.zrexpress.app';

    private const API = '/api/v1';
    private const PAGE_SIZE = 1000;
    private const MAX_AMOUNT = 150000;
    private const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    private HttpClient $http;
    private bool $includeRaw;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, Location[]> keyed by wilaya UUID */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $apiKey = (string) $options->get('apiKey', '');
        $tenant = (string) $options->get('tenant', '');
        if ($apiKey === '' || $tenant === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'ZRExpress requires "apiKey" and "tenant"', null, null, null, self::NAME);
        }

        $this->includeRaw = $options->includeRaw;
        $this->http = $http ?? new HttpClient(
            baseUrl: $options->baseUrl ?? self::DEFAULT_BASE_URL,
            provider: self::NAME,
            headers: [
                'X-Api-Key' => $apiKey,
                'X-Tenant' => $tenant,
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

        if ($input->price > self::MAX_AMOUNT) {
            throw ShippingError::validation('price must be <= ' . self::MAX_AMOUNT . ' DZD for ZRExpress', self::NAME, 'price');
        }
        if ($input->orderId !== null && strlen($input->orderId) > 100) {
            throw ShippingError::validation('orderId must be at most 100 characters', self::NAME, 'orderId');
        }
        $description = $input->productDescription();
        if (strlen(trim($description)) < 2) {
            throw ShippingError::validation('Product description must be at least 2 characters', self::NAME, 'productName');
        }

        $phone = Phone::toInternational($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toInternational($input->phone2, self::NAME, 'phone2') : null;

        $wilayaId = $this->resolveWilayaId($input->wilayaId ?? $input->wilayaName, $input->wilayaId === null);
        $communeId = $this->resolveCommuneId($wilayaId, $input->communeId ?? $input->communeName, $input->communeId === null);

        $products = [];
        foreach ($input->products() as $i => $item) {
            $product = array_filter([
                'productName' => $item->name,
                'quantity' => $item->quantity,
                'unitPrice' => $item->unitPrice,
                'productSku' => $item->sku,
                'stockType' => 'none',
            ], static fn ($v) => $v !== null);
            if ($i === 0) {
                $product += array_filter([
                    'length' => $input->length,
                    'width' => $input->width,
                    'height' => $input->height,
                ], static fn ($v) => $v !== null);
            }
            $products[] = $product;
        }

        $body = [
            'customer' => [
                'customerId' => self::uuid4(),
                'name' => $input->recipientName,
                'phone' => array_filter(['number1' => $phone, 'number2' => $phone2], static fn ($v) => $v !== null),
            ],
            'deliveryAddress' => [
                'street' => $input->address,
                'cityTerritoryId' => $wilayaId,
                'districtTerritoryId' => $communeId,
            ],
            'orderedProducts' => $products,
            'description' => substr($description, 0, 250),
            'amount' => $input->price,
            'deliveryType' => $input->isStopDesk ? 'pickup-point' : 'home',
        ];
        if ($input->isStopDesk) {
            $body['hubId'] = $input->stopDeskId;
        }
        if ($input->weight !== null) {
            $body['weight'] = ['weight' => $input->weight];
        }
        if ($input->orderId !== null) {
            $body['externalId'] = $input->orderId;
        }

        $created = $this->http->request('POST', self::API . '/parcels', [], $body);
        $id = is_array($created) ? ($created['id'] ?? null) : (is_string($created) ? $created : null);
        if (!is_string($id) || $id === '') {
            throw ShippingError::providerError('ZRExpress did not return a parcel id', self::NAME, $this->raw($created));
        }

        return $this->toParcel($this->fetchParcel($id));
    }

    public function track(string $trackingNumber): TrackResult
    {
        $native = $this->fetchParcel($trackingNumber);
        $parcel = $this->toParcel($native);

        $history = $this->http->request('GET', self::API . '/parcels/' . rawurlencode($parcel->id) . '/state-history');
        $items = self::listItems($history);

        $events = [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $state = $item['newState'] ?? $item['state'] ?? [];
            [$name, $description] = self::stateNameAndLabel($state);
            $events[] = new TrackingEvent(
                status: StatusMapper::zrexpress($name),
                label: $description ?? $name ?? '',
                at: Dates::toIso($item['createdAt'] ?? $item['date'] ?? null),
                raw: $this->raw($item),
            );
        }
        usort($events, static fn (TrackingEvent $a, TrackingEvent $b) => self::timestamp($a->at) <=> self::timestamp($b->at));

        return new TrackResult($parcel, $events);
    }

    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $wilayaId = $this->resolveWilayaId($query->toWilayaId, false);

        $native = $this->http->request('GET', self::API . '/delivery-pricing/rates/' . rawurlencode($wilayaId));
        $rate = $native;
        if (is_array($native) && array_is_list($native)) {
            $rate = $native[0] ?? null;
            foreach ($native as $candidate) {
                if (is_array($candidate) && ($candidate['toTerritoryId'] ?? null) === $wilayaId) {
                    $rate = $candidate;
                    break;
                }
            }
        }

        $prices = [];
        foreach ((is_array($rate) ? ($rate['deliveryPrices'] ?? []) : []) as $entry) {
            if (!is_array($entry) || !isset($entry['price']) || !is_numeric($entry['price'])) {
                continue;
            }
            $type = $entry['deliveryType'] ?? null;
            if (is_array($type)) {
                $type = $type['value'] ?? $type['name'] ?? null;
            }
            $prices[Text::key((string) $type)] = $entry['price'] + 0;
        }

        $home = $prices['home'] ?? null;
        $pickup = $prices['pickuppoint'] ?? null;
        $fee = $query->isStopDesk ? $pickup : $home;
        if ($fee === null) {
            throw new ShippingError(
                ShippingError::NOT_FOUND,
                'No ZRExpress rate for this destination/delivery type',
                null,
                null,
                $this->raw($native),
                self::NAME,
            );
        }

        $returnFee = is_array($rate) ? ($rate['returnPrice'] ?? $rate['returnFee'] ?? null) : null;

        return new FeeQuote(
            deliveryFee: $fee,
            returnFee: is_numeric($returnFee) ? $returnFee + 0 : null,
            stopDeskFee: $pickup,
            raw: $this->raw($native),
        );
    }

    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $this->wilayas = array_map(
                fn (array $t) => $this->toLocation($t),
                $this->searchTerritories([['field' => 'level', 'operator' => 'eq', 'value' => 'wilaya']]),
            );
        }

        return $this->wilayas;
    }

    public function getCommunes(string|int $wilayaId): array
    {
        return $this->communesOf($this->resolveWilayaId($wilayaId, false));
    }

    /** Not available yet: the ZRExpress hub listing endpoint is not documented. Pass the hub UUID as `stopDeskId`. */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        throw ShippingError::notSupported('ZRExpress hub listing is not supported yet; pass the hub UUID as stopDeskId', self::NAME);
    }

    public function cancelParcel(string $trackingNumberOrId): void
    {
        $id = $trackingNumberOrId;
        if (preg_match(self::UUID_RE, $id) !== 1) {
            $native = $this->fetchParcel($trackingNumberOrId);
            $id = (string) ($native['id'] ?? '');
            if ($id === '') {
                throw ShippingError::providerError('ZRExpress parcel has no id', self::NAME, $this->raw($native));
            }
        }

        $this->http->request('DELETE', self::API . '/parcels/' . rawurlencode($id));
    }

    /** Probes territories search for wilayas (bypasses cache). */
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
     * RFC 7807 problem details → [message, details].
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        if (!is_array($body)) {
            return HttpClient::defaultErrorParser($status, $body);
        }

        $message = $body['detail'] ?? $body['title'] ?? null;
        $details = null;
        $errors = $body['errors'] ?? null;
        if (is_array($errors) && $errors !== []) {
            $details = [];
            if (array_is_list($errors)) {
                foreach ($errors as $error) {
                    if (is_array($error)) {
                        $details[] = array_filter([
                            'message' => (string) ($error['description'] ?? $error['message'] ?? ''),
                            'code' => $error['code'] ?? null,
                            'field' => $error['field'] ?? $error['name'] ?? null,
                        ], static fn ($v) => $v !== null);
                    } elseif (is_string($error)) {
                        $details[] = ['message' => $error];
                    }
                }
            } else {
                foreach ($errors as $field => $messages) {
                    foreach ((array) $messages as $msg) {
                        $details[] = ['field' => (string) $field, 'message' => (string) $msg];
                    }
                }
            }
        }

        return [is_string($message) ? $message : null, $details];
    }

    /** @return array<string, mixed> */
    private function fetchParcel(string $idOrTracking): array
    {
        $native = $this->http->request('GET', self::API . '/parcels/' . rawurlencode($idOrTracking));
        if (!is_array($native)) {
            throw ShippingError::providerError('Unexpected ZRExpress parcel response', self::NAME, $this->raw($native));
        }

        return $native;
    }

    /** @param array<string, mixed> $native */
    private function toParcel(array $native): Parcel
    {
        [$stateName] = self::stateNameAndLabel($native['state'] ?? $native['stateName'] ?? null);
        $id = (string) ($native['id'] ?? '');
        if ($id === '') {
            throw ShippingError::providerError('ZRExpress parcel has no id', self::NAME, $this->raw($native));
        }

        return new Parcel(
            id: $id,
            trackingNumber: (string) ($native['trackingNumber'] ?? $id),
            status: StatusMapper::zrexpress($stateName),
            provider: self::NAME,
            raw: $this->raw($native),
        );
    }

    /**
     * @param array<string, mixed> $t
     */
    private function toLocation(array $t): Location
    {
        $code = $t['code'] ?? null;
        if (($code === null || $code === '' || $code === 0) && ($t['level'] ?? null) === 'commune') {
            $code = $t['postalCode'] ?? $t['PostalCode'] ?? null;
        }

        return new Location(
            id: (string) ($t['id'] ?? ''),
            name: (string) ($t['name'] ?? ''),
            parentId: isset($t['parentId']) && $t['parentId'] !== '' ? (string) $t['parentId'] : null,
            code: $code === null || $code === '' ? null : (string) $code,
            raw: $this->raw($t),
        );
    }

    /** @return Location[] */
    private function communesOf(string $wilayaUuid): array
    {
        if (!isset($this->communes[$wilayaUuid])) {
            $this->communes[$wilayaUuid] = array_map(
                fn (array $t) => $this->toLocation($t),
                $this->searchTerritories([
                    ['field' => 'level', 'operator' => 'eq', 'value' => 'commune'],
                    ['field' => 'parentId', 'operator' => 'eq', 'value' => $wilayaUuid],
                ]),
            );
        }

        return $this->communes[$wilayaUuid];
    }

    /**
     * @param list<array{field: string, operator: string, value: mixed}> $filters
     * @return list<array<string, mixed>> Deliverable territories only.
     */
    private function searchTerritories(array $filters): array
    {
        $all = [];
        $page = 1;
        do {
            $response = $this->http->request('POST', self::API . '/territories/search', [], [
                'pageNumber' => $page,
                'pageSize' => self::PAGE_SIZE,
                'orderBy' => ['code asc'],
                'advancedFilter' => ['logic' => 'and', 'filters' => $filters],
            ]);
            if (!is_array($response)) {
                throw ShippingError::providerError('Unexpected ZRExpress territories response', self::NAME, $this->raw($response));
            }
            foreach (self::listItems($response) as $item) {
                if (is_array($item) && self::isDeliverable($item)) {
                    $all[] = $item;
                }
            }
            $hasNext = (bool) ($response['hasNext'] ?? false);
            $page++;
        } while ($hasNext && $page <= 100);

        return $all;
    }

    /** @param array<string, mixed> $territory */
    private static function isDeliverable(array $territory): bool
    {
        $delivery = $territory['delivery'] ?? $territory['deliveryCapability'] ?? $territory['DeliveryCapability'] ?? null;
        if (!is_array($delivery)) {
            return true;
        }
        $home = $delivery['hasHomeDelivery'] ?? $delivery['HasHomeDelivery'] ?? null;
        $pickup = $delivery['hasPickupPoint'] ?? $delivery['HasPickupPoint'] ?? null;
        if ($home === null && $pickup === null) {
            return true;
        }

        return (bool) $home || (bool) $pickup;
    }

    /**
     * Accepts a wilaya UUID (returned as-is), an official code 1–58, or (when $byName) a name.
     */
    private function resolveWilayaId(string|int|null $value, bool $byName): string
    {
        $value = trim((string) $value);
        if (!$byName && preg_match(self::UUID_RE, $value) === 1) {
            return $value;
        }

        foreach ($this->getWilayas() as $w) {
            if ($byName) {
                if (Text::key($w->name) === Text::key($value)) {
                    return $w->id;
                }
            } elseif ($w->id === $value || (ctype_digit($value) && $w->code !== null && (int) $w->code === (int) $value)) {
                return $w->id;
            }
        }

        throw ShippingError::notFound(($byName ? 'Unknown wilaya name: ' : 'Unknown wilaya: ') . $value, self::NAME);
    }

    /**
     * Accepts a commune UUID (returned as-is), a code/postal code, or (when $byName) a name.
     */
    private function resolveCommuneId(string $wilayaUuid, string|int|null $value, bool $byName): string
    {
        $value = trim((string) $value);
        if (!$byName && preg_match(self::UUID_RE, $value) === 1) {
            return $value;
        }

        foreach ($this->communesOf($wilayaUuid) as $c) {
            if ($byName ? Text::key($c->name) === Text::key($value) : ($c->id === $value || $c->code === $value)) {
                return $c->id;
            }
        }

        throw ShippingError::notFound(
            ($byName ? 'Unknown commune name: ' : 'Unknown commune: ') . $value . ' in wilaya ' . $wilayaUuid,
            self::NAME,
        );
    }

    /**
     * @return array{0: ?string, 1: ?string} [name, description]
     */
    private static function stateNameAndLabel(mixed $state): array
    {
        if (is_string($state)) {
            return [$state, null];
        }
        if (!is_array($state)) {
            return [null, null];
        }
        $name = $state['name'] ?? $state['code'] ?? null;
        $description = $state['description'] ?? $state['label'] ?? null;

        return [
            is_string($name) ? $name : null,
            is_string($description) && $description !== '' ? $description : null,
        ];
    }

    /** @return list<mixed> */
    private static function listItems(mixed $response): array
    {
        if (!is_array($response)) {
            return [];
        }
        if (array_is_list($response)) {
            return $response;
        }
        foreach (['items', 'data', 'history', 'stateHistory'] as $key) {
            if (isset($response[$key]) && is_array($response[$key])) {
                return array_values($response[$key]);
            }
        }

        return [];
    }

    private static function timestamp(string $iso): int
    {
        $t = strtotime($iso);

        return $t === false ? 0 : $t;
    }

    private function raw(mixed $value): mixed
    {
        return $this->includeRaw ? $value : null;
    }

    private static function uuid4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
