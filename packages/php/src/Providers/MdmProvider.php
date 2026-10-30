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
use DzDelivery\Support\Dates;
use DzDelivery\Support\Health;
use DzDelivery\Support\Phone;
use DzDelivery\Support\StatusMapper;
use DzDelivery\Support\Text;

/**
 * MDM Express — api.mdm.express (shipping API v2). Mapping and assumptions: docs/PROVIDERS.md#mdm.
 *
 * Options: 'apiKey' (sent as x-api-key) and 'storeId' (STR-…, required by createParcel; also
 * scopes geo, office and parcel lookups).
 *
 * Geo ids: wilaya DZA16, commune DZA161601 (code 1601). Location id of a wilaya is its
 * official code (16); communes keep the MDM city id. Parcels ship products stocked at MDM:
 * every product line needs its MDM product id (productId or sku, PRD-…). Errors share one
 * shape: { method, path, status, correlationId, error: { code, message, payload? } }.
 * No cancellation endpoint: cancelParcel throws NOT_SUPPORTED.
 */
final class MdmProvider implements ShippingProviderInterface
{
    public const NAME = 'mdm';
    public const DEFAULT_BASE_URL = 'https://api.mdm.express';

    private const COUNTRY = 'DZA';
    private const GEO_PAGE_SIZE = 100;
    private const GEO_MAX_PAGES = 20;
    private const LIST_MAX_PAGE_SIZE = 100;
    private const LIST_MAX_PAGES = 100;

    /** Validation payload path → ParcelInput field. Same table as the TS provider. */
    private const FIELDS = [
        'storeId' => 'storeId',
        'destination.cityId' => 'communeId',
        'destination.streetAddress' => 'address',
        'client.firstName' => 'recipientName',
        'client.lastName' => 'recipientName',
        'client.phone' => 'phone',
        'client.phone2' => 'phone2',
        'products' => 'productList',
        'productsPrice' => 'price',
        'stopDeskId' => 'stopDeskId',
        'weight' => 'weight',
        'notes' => 'remark',
    ];

    private HttpClient $http;
    private ?string $storeId;
    private bool $includeRaw;

    /** @var Location[]|null */
    private ?array $wilayas = null;

    /** @var array<string, list<Location>> keyed by wilaya code */
    private array $communes = [];

    public function __construct(ClientOptions $options, ?HttpClient $http = null)
    {
        $apiKey = trim((string) $options->get('apiKey', ''));
        if ($apiKey === '') {
            throw new ShippingError(ShippingError::AUTH_FAILED, 'MDM requires "apiKey"', null, null, null, self::NAME);
        }

        $storeId = trim((string) $options->get('storeId', ''));
        $this->storeId = $storeId !== '' ? $storeId : null;
        $this->includeRaw = $options->includeRaw;
        $this->http = $http ?? new HttpClient(
            baseUrl: Dates::requireHttps(trim((string) ($options->baseUrl ?? '')) ?: self::DEFAULT_BASE_URL, self::NAME),
            provider: self::NAME,
            headers: ['x-api-key' => $apiKey],
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

    /**
     * POST api/v2/shipping/parcels. price is what the recipient pays: it is sent as
     * productsPrice with isShippingFree = true, so MDM adds no delivery fee on top.
     * Each product line needs its MDM product id (productId, else sku) as trackingId;
     * an unknown id is HTTP 403 "Products not found" → VALIDATION_ERROR on productList.
     */
    public function createParcel(ParcelInput|array $input): Parcel
    {
        $input = ParcelInput::from($input, self::NAME);
        $storeId = $this->requireStore('createParcel');
        $missingId = $input->productList === null || $input->productList === [];
        foreach ($input->productList ?? [] as $p) {
            $missingId = $missingId || trim((string) ($p->productId ?? $p->sku)) === '';
        }
        if ($missingId) {
            throw ShippingError::validation(
                'MDM ships products stocked in its catalog: give every productList line its MDM product id (productId or sku, e.g. PRD-…)',
                self::NAME,
                'productList',
            );
        }
        $phone = Phone::toLocal($input->phone, self::NAME, 'phone');
        $phone2 = $input->phone2 !== null ? Phone::toLocal($input->phone2, self::NAME, 'phone2') : null;
        $wilayaCode = $this->resolveWilayaCode($input->wilayaId ?? $input->wilayaName);
        $city = $this->resolveCommune($wilayaCode, $input->communeId ?? $input->communeName);

        $parts = preg_split('/\s+/', trim($input->recipientName)) ?: [];
        $first = (string) array_shift($parts);
        $client = ['firstName' => $first, 'lastName' => $parts !== [] ? implode(' ', $parts) : $first, 'phone' => $phone];
        if ($phone2 !== null) {
            $client['phone2'] = $phone2;
        }
        $products = [];
        foreach ($input->productList as $p) {
            $line = ['trackingId' => trim((string) ($p->productId ?? $p->sku)), 'quantity' => $p->quantity];
            if (trim($p->name) !== '') {
                $line['displayName'] = trim($p->name);
            }
            if ($p->unitPrice !== null) {
                $line['price'] = $p->unitPrice;
            }
            $products[] = $line;
        }

        $body = [
            'storeId' => $storeId,
            'destination' => ['cityId' => $city->id, 'streetAddress' => trim($input->address) !== '' ? trim($input->address) : $city->name],
            'client' => $client,
            'products' => $products,
            'productsPrice' => (int) round($input->price),
            'isShippingFree' => true,
            'isStopDesk' => $input->isStopDesk,
        ];
        if ($input->isStopDesk) {
            $body['stopDeskId'] = trim((string) $input->stopDeskId);
        }
        foreach (['weight', 'length', 'width', 'height'] as $dimension) {
            if ($input->$dimension !== null) {
                $body[$dimension] = $input->$dimension;
            }
        }
        // MDM parcels have no merchant reference field: orderId goes in the notes.
        $notes = array_values(array_filter([
            $input->orderId !== null && trim($input->orderId) !== '' ? 'Ref: ' . trim($input->orderId) : null,
            $input->remark !== null && trim($input->remark) !== '' ? trim($input->remark) : null,
        ]));
        if ($notes !== []) {
            $body['notes'] = implode(' — ', $notes);
        }

        try {
            $res = $this->http->request('POST', 'api/v2/shipping/parcels', [], $body);
        } catch (ShippingError $e) {
            // Unknown catalog products come back as HTTP 403 AUTH.NOT_AUTHORIZED "Products not found: ...".
            if ($e->httpStatus === 403 && stripos($e->getMessage(), 'products not found') !== false) {
                throw new ShippingError(
                    ShippingError::VALIDATION_ERROR,
                    $e->getMessage(),
                    403,
                    [['field' => 'productList', 'message' => $e->getMessage(), 'code' => 'AUTH.NOT_AUTHORIZED']],
                    $e->raw,
                    self::NAME,
                    $e,
                );
            }
            throw $e;
        }
        $tracking = is_array($res) ? self::text($res['trackingId'] ?? null) : null;
        if ($tracking === null) {
            throw ShippingError::providerError('MDM did not return a tracking id', self::NAME, $this->raw($res));
        }

        return new Parcel($tracking, $tracking, ParcelStatus::PENDING, self::NAME, $this->raw($res));
    }

    /** GET api/v2/shipping/parcels/{trackingId}: current status and statusHistory. */
    public function track(string $trackingNumber): TrackResult
    {
        $tracking = trim($trackingNumber);
        if ($tracking === '') {
            throw ShippingError::validation('trackingNumber is required', self::NAME, 'trackingNumber');
        }

        $body = $this->http->request('GET', 'api/v2/shipping/parcels/' . rawurlencode($tracking));
        if (!is_array($body) || array_is_list($body)) {
            throw ShippingError::providerError('Unexpected MDM parcel response', self::NAME, $this->raw($body));
        }
        $rows = [];
        foreach (is_array($body['statusHistory'] ?? null) ? $body['statusHistory'] : [] as $i => $step) {
            if (is_array($step)) {
                $rows[] = ['step' => $step, 'i' => $i, 'at' => Dates::toIso(self::text($step['date'] ?? null) ?? self::text($step['createdAt'] ?? null) ?? '')];
            }
        }
        usort($rows, static fn (array $x, array $y) => Dates::compare($x['at'], $y['at']) ?: $x['i'] <=> $y['i']);

        $events = [];
        foreach ($rows as ['step' => $step, 'at' => $at]) {
            $status = self::text($step['status'] ?? null) ?? '';
            $notes = self::text($step['notes'] ?? null);
            $events[] = new TrackingEvent(
                status: StatusMapper::mdm($status),
                label: $notes !== null ? "$status ($notes)" : $status,
                at: $at,
                raw: $this->raw($step),
            );
        }

        return new TrackResult($this->toParcel($body, $tracking), $events);
    }

    /**
     * POST api/v2/shipping/parcels/calculate-fees to one commune (toCommuneId, else the
     * wilaya's first deliverable commune). fees.shipping → deliveryFee, fees.return → returnFee.
     */
    public function getFees(FeeQuery|array $query): FeeQuote
    {
        $query = FeeQuery::from($query, self::NAME);
        $wilayaCode = $this->resolveWilayaCode($query->toWilayaId);
        $city = $query->toCommuneId !== null && trim((string) $query->toCommuneId) !== ''
            ? $this->resolveCommune($wilayaCode, $query->toCommuneId)
            : ($this->getCommunes($wilayaCode)[0] ?? null);
        if ($city === null) {
            throw ShippingError::notFound("MDM delivers to no commune of wilaya $wilayaCode", self::NAME);
        }

        $body = [
            'destinationAddress' => ['cityId' => $city->id, 'streetAddress' => $city->name],
            'productsPrice' => 0,
            'isShippingFree' => false,
            'isStopDesk' => $query->isStopDesk,
        ];
        if ($this->storeId !== null) {
            $body['storeId'] = $this->storeId;
        }
        foreach (['weight', 'length', 'width', 'height'] as $dimension) {
            if ($query->$dimension !== null) {
                $body[$dimension] = $query->$dimension;
            }
        }

        $res = $this->http->request('POST', 'api/v2/shipping/parcels/calculate-fees', [], $body);
        $fees = is_array($res) && is_array($res['fees'] ?? null) ? $res['fees'] : null;
        $fee = self::number($fees['shipping'] ?? null);
        if ($fee === null) {
            throw ShippingError::providerError('Unexpected MDM fees response', self::NAME, $this->raw($res));
        }

        return new FeeQuote(
            deliveryFee: $fee,
            returnFee: self::number($fees['return'] ?? null),
            stopDeskFee: $query->isStopDesk ? $fee : null,
            raw: $this->raw($res),
        );
    }

    /** GET api/geo/countries/DZA/deliverable-states (paginated). Location id = official code. */
    public function getWilayas(): array
    {
        if ($this->wilayas === null) {
            $wilayas = [];
            foreach ($this->geoList('api/geo/countries/' . self::COUNTRY . '/deliverable-states') as $s) {
                $code = self::codeOfState($s);
                if ($code !== null) {
                    $wilayas[] = new Location(id: $code, name: trim((string) ($s['name'] ?? '')), parentId: null, code: $code, raw: $this->raw($s));
                }
            }
            usort($wilayas, static fn (Location $a, Location $b) => (int) $a->id <=> (int) $b->id);
            $this->wilayas = $wilayas;
        }

        return $this->wilayas;
    }

    /** …/deliverable-states/DZA16/deliverable-cities. Location id = MDM city id (DZA161601). */
    public function getCommunes(string|int $wilayaId): array
    {
        $code = $this->resolveWilayaCode($wilayaId);
        if (!isset($this->communes[$code])) {
            $communes = [];
            $path = 'api/geo/countries/' . self::COUNTRY . '/deliverable-states/' . self::stateIdOf($code) . '/deliverable-cities';
            foreach ($this->geoList($path) as $c) {
                if (!self::hasValue($c['id'] ?? null) || !self::hasValue($c['name'] ?? null)) {
                    continue;
                }
                $communes[] = new Location(
                    id: (string) $c['id'],
                    name: trim((string) $c['name']),
                    parentId: $code,
                    code: self::text($c['code'] ?? null),
                    raw: $this->raw($c),
                );
            }
            $this->communes[$code] = $communes;
        }

        return $this->communes[$code];
    }

    /** GET api/v2/shipping/companies/offices?countryId=DZA&stateId=…[&cityId]. Disabled offices are skipped. */
    public function getStopDesks(StopDeskQuery|array $query): array
    {
        $query = StopDeskQuery::from($query, self::NAME);
        $code = $this->resolveWilayaCode($query->wilayaId);
        $params = ['countryId' => self::COUNTRY, 'stateId' => self::stateIdOf($code)];
        if ($query->communeId !== null) {
            $params['cityId'] = $this->resolveCommune($code, $query->communeId)->id;
        }
        if ($this->storeId !== null) {
            $params['storeId'] = $this->storeId;
        }

        $body = $this->http->request('GET', 'api/v2/shipping/companies/offices', $params);
        if (!is_array($body) || !is_array($body['list'] ?? null)) {
            throw ShippingError::providerError('Unexpected MDM offices response', self::NAME, $this->raw($body));
        }
        $desks = [];
        foreach ($body['list'] as $o) {
            if (!is_array($o) || !self::hasValue($o['id'] ?? null) || ($o['enabled'] ?? null) === false) {
                continue;
            }
            $address = is_array($o['address'] ?? null) ? $o['address'] : [];
            $phone = null;
            foreach (is_array($o['phones'] ?? null) ? $o['phones'] : [] as $p) {
                $phone ??= self::text($p);
            }
            $desks[] = new StopDesk(
                id: (string) $o['id'],
                name: trim((string) ($o['name'] ?? $o['id'])),
                address: self::text($address['streetAddress'] ?? null),
                communeId: self::text($address['cityId'] ?? null),
                wilayaId: $code,
                phone: $phone,
                raw: $this->raw($o),
            );
        }

        return $desks;
    }

    /**
     * POST api/v2/shipping/parcels/search, newest first. keyword → filters.search,
     * updatedSince → filters.updatedAt.start, status → filters.status (every MDM slug of that
     * unified status), the store → filters.storeId; orderId (stored in the notes, see
     * createParcel) is filtered client-side.
     */
    public function listParcels(ParcelListQuery|array|null $query = null): ParcelListPage
    {
        $query = ParcelListQuery::from($query, self::NAME);
        $pageSize = min(max($query->pageSize, 1), self::LIST_MAX_PAGE_SIZE);

        if ($query->allPages) {
            $all = [];
            $totalCount = 0;
            $lastRaw = null;
            $hasNext = true;
            for ($n = 1; $hasNext && $n <= self::LIST_MAX_PAGES; $n++) {
                [$parcels, $count, $hasNext, $lastRaw] = $this->listPage($query, $n, $pageSize);
                array_push($all, ...$parcels);
                if ($n === 1) {
                    $totalCount = $count;
                }
            }

            // hasNext stays true when the page cap cut the walk short.
            return new ParcelListPage($all, 1, $pageSize, $totalCount, $hasNext, $this->raw($lastRaw));
        }

        [$parcels, $totalCount, $hasNext, $raw] = $this->listPage($query, $query->page, $pageSize);

        return new ParcelListPage($parcels, $query->page, $pageSize, $totalCount, $hasNext, $this->raw($raw));
    }

    public function cancelParcel(string $trackingNumberOrId): void
    {
        throw ShippingError::notSupported('MDM has no parcel cancellation endpoint (cancel from the MDM dashboard)', self::NAME);
    }

    /** Probes the deliverable wilayas (bypasses cache). */
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
     * { error: { code, message, payload? } }. INVALID_REQUEST: payload maps each invalid path
     * to its message (products.0.trackingId → productList). Elsewhere it holds context values.
     *
     * @return array{0: ?string, 1: ?array}
     */
    public static function parseError(int $status, mixed $body): array
    {
        if (!is_array($body)) {
            return HttpClient::defaultErrorParser($status, $body);
        }
        $error = is_array($body['error'] ?? null) ? $body['error'] : null;
        if ($error === null) {
            return [self::text($body['message'] ?? null), null];
        }
        $code = self::text($error['code'] ?? null);
        $message = self::text($error['message'] ?? null) ?? $code;
        $details = [];
        if ($code === 'INVALID_REQUEST' && is_array($error['payload'] ?? null)) {
            foreach ($error['payload'] as $key => $value) {
                if (is_string($value)) {
                    $details[] = ['field' => self::fieldOf((string) $key), 'message' => $value, 'code' => $code];
                }
            }
        }
        if ($details === [] && $code !== null) {
            $details[] = ['message' => $message ?? $code, 'code' => $code];
        }

        return [$message, $details === [] ? null : $details];
    }

    // --- internals ---------------------------------------------------------------

    private function requireStore(string $method): string
    {
        if ($this->storeId === null) {
            throw ShippingError::validation("MDM $method requires `storeId` in the client config", self::NAME, 'storeId');
        }

        return $this->storeId;
    }

    /** @param array<string, mixed> $row */
    private function toParcel(array $row, string $fallbackTracking): Parcel
    {
        $tracking = self::text($row['trackingId'] ?? null) ?? $fallbackTracking;

        return new Parcel($tracking, $tracking, StatusMapper::mdm(self::text($row['status'] ?? null)), self::NAME, $this->raw($row));
    }

    /** @return array{0: list<Parcel>, 1: int, 2: bool, 3: mixed} */
    private function listPage(ParcelListQuery $query, int $page, int $pageSize): array
    {
        $filters = [];
        if ($this->storeId !== null) {
            $filters['storeId'] = [$this->storeId];
        }
        if ($query->keyword !== null && trim($query->keyword) !== '') {
            $filters['search'] = trim($query->keyword);
        }
        if ($query->status !== null) {
            $filters['status'] = StatusMapper::mdmSlugs($query->status);
        }
        if ($query->updatedSince !== null) {
            try {
                $since = new \DateTimeImmutable($query->updatedSince);
            } catch (\Exception) {
                throw ShippingError::validation('updatedSince must be an ISO 8601 date', self::NAME, 'updatedSince');
            }
            $filters['updatedAt'] = ['start' => $since->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z')];
        }

        $body = $this->http->request('POST', 'api/v2/shipping/parcels/search', [], [
            'filters' => $filters === [] ? new \stdClass() : $filters,
            'sortBy' => ['createdAt' => 'DESC'],
            'pagination' => ['page' => $page, 'perPage' => $pageSize],
        ]);
        if (!is_array($body) || !is_array($body['list'] ?? null)) {
            throw ShippingError::providerError('Unexpected MDM parcel list response', self::NAME, $this->raw($body));
        }
        $items = array_values(array_filter($body['list'], 'is_array'));
        $orderId = $query->orderId !== null ? trim($query->orderId) : null;
        $parcels = [];
        foreach ($items as $item) {
            if ($orderId === null || str_contains((string) self::text($item['notes'] ?? null), "Ref: $orderId")) {
                $parcels[] = $this->toParcel($item, '');
            }
        }
        $pagination = is_array($body['pagination'] ?? null) ? $body['pagination'] : [];
        $total = self::number($pagination['total'] ?? null);

        return [
            $parcels,
            $total !== null ? (int) $total : ($page - 1) * $pageSize + count($items),
            is_bool($pagination['hasMore'] ?? null) ? $pagination['hasMore'] : count($items) === $pageSize,
            $body,
        ];
    }

    /**
     * Every page of a geo listing (pagination.hasMore), capped at GEO_MAX_PAGES.
     *
     * @return list<array<string, mixed>>
     */
    private function geoList(string $path): array
    {
        $rows = [];
        for ($page = 1; $page <= self::GEO_MAX_PAGES; $page++) {
            $params = ['page' => $page, 'perPage' => self::GEO_PAGE_SIZE];
            if ($this->storeId !== null) {
                $params['storeId'] = $this->storeId;
            }
            $body = $this->http->request('GET', $path, $params);
            if (!is_array($body) || !is_array($body['list'] ?? null)) {
                throw ShippingError::providerError('Unexpected MDM geo response', self::NAME, $this->raw($body));
            }
            foreach ($body['list'] as $row) {
                if (is_array($row)) {
                    $rows[] = $row;
                }
            }
            if (!is_array($body['pagination'] ?? null) || ($body['pagination']['hasMore'] ?? null) !== true) {
                break;
            }
        }

        return $rows;
    }

    /** Official code 1–58 (or DZA16) as-is; names through the deliverable wilayas. */
    private function resolveWilayaCode(string|int|null $ref): string
    {
        $raw = trim((string) $ref);
        $value = (string) preg_replace('/^DZA/i', '', $raw);
        if (preg_match('/^\d{1,2}$/', $value) === 1 && (int) $value >= 1 && (int) $value <= 58) {
            return (string) (int) $value;
        }
        if (!ctype_digit($value)) {
            foreach ($this->getWilayas() as $w) {
                if (Text::key($w->name) === Text::key($value)) {
                    return $w->id;
                }
            }
        }

        throw ShippingError::notFound('Unknown wilaya: ' . $raw, self::NAME);
    }

    /** By MDM city id, city code, exact name, then spelling-tolerant name (unambiguous only). */
    private function resolveCommune(string $wilayaCode, string|int|null $ref): Location
    {
        $value = trim((string) $ref);
        $communes = $this->getCommunes($wilayaCode);
        foreach ($communes as $c) {
            if ($c->id === $value || $c->code === $value) {
                return $c;
            }
        }
        foreach ($communes as $c) {
            if (Text::key($c->name) === Text::key($value)) {
                return $c;
            }
        }
        $found = Text::findLoosely($communes, $value, static fn (Location $c) => $c->name);
        if ($found === null) {
            throw ShippingError::notFound("Unknown commune: $value in wilaya $wilayaCode", self::NAME);
        }

        return $found;
    }

    /** DZA16 ↔ 16. */
    private static function stateIdOf(string $code): string
    {
        return self::COUNTRY . str_pad((string) (int) $code, 2, '0', STR_PAD_LEFT);
    }

    /** @param array<string, mixed> $row */
    private static function codeOfState(array $row): ?string
    {
        $raw = self::text($row['code'] ?? null) ?? (self::text($row['id'] ?? null) !== null ? (string) preg_replace('/^[A-Z]{3}/i', '', (string) $row['id']) : null);

        return $raw !== null && ctype_digit($raw) ? (string) (int) $raw : null;
    }

    /** products.0.trackingId → productList, destination.cityId → communeId. */
    private static function fieldOf(string $path): string
    {
        if (preg_match('/^products(\.|$)/', $path) === 1) {
            return 'productList';
        }

        return self::FIELDS[$path] ?? $path;
    }

    private static function hasValue(mixed $value): bool
    {
        return is_scalar($value) && trim((string) $value) !== '';
    }

    private static function text(mixed $value): ?string
    {
        return self::hasValue($value) ? trim((string) $value) : null;
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
